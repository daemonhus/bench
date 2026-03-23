package events

import "sync"

// Topic identifies what changed.
type Topic string

const (
	TopicAnnotations Topic = "annotations" // findings or comments
	TopicBaselines   Topic = "baselines"
	TopicGit         Topic = "git"
)

// Broker is an in-process pub/sub event broker.
// Multiple SSE connections subscribe; mutation handlers publish.
type Broker struct {
	mu          sync.RWMutex
	subscribers map[int64]chan Topic
	nextID      int64
}

func NewBroker() *Broker {
	return &Broker{subscribers: make(map[int64]chan Topic)}
}

// Subscribe registers a new listener. Returns an ID for unsubscribing
// and a channel that receives topic notifications.
func (b *Broker) Subscribe() (int64, <-chan Topic) {
	b.mu.Lock()
	defer b.mu.Unlock()
	id := b.nextID
	b.nextID++
	ch := make(chan Topic, 8)
	b.subscribers[id] = ch
	return id, ch
}

// Unsubscribe removes a listener and closes its channel.
func (b *Broker) Unsubscribe(id int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if ch, ok := b.subscribers[id]; ok {
		close(ch)
		delete(b.subscribers, id)
	}
}

// Publish sends a topic notification to all subscribers.
// Non-blocking: drops the event for any subscriber whose buffer is full.
func (b *Broker) Publish(topic Topic) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, ch := range b.subscribers {
		select {
		case ch <- topic:
		default:
			// subscriber buffer full, skip
		}
	}
}
