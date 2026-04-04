package db

// writeQueue routes all database writes through a single goroutine,
// preventing SQLite SQLITE_BUSY errors from concurrent writers.
type writeQueue struct {
	ops  chan writeOp
	done chan struct{}
}

type writeOp struct {
	fn   func()
	done chan struct{}
}

func newWriteQueue() *writeQueue {
	q := &writeQueue{
		ops:  make(chan writeOp, 256),
		done: make(chan struct{}),
	}
	go q.run()
	return q
}

func (q *writeQueue) run() {
	defer close(q.done)
	for op := range q.ops {
		op.fn()
		close(op.done)
	}
}

// close drains in-flight operations and stops the worker goroutine.
func (q *writeQueue) close() {
	close(q.ops)
	<-q.done
}

// submit enqueues fn and blocks until it has executed.
func (q *writeQueue) submit(fn func()) {
	op := writeOp{fn: fn, done: make(chan struct{})}
	q.ops <- op
	<-op.done
}

// wq routes a (T, error)-returning function through the write queue.
// A package-level function is used because Go does not allow generic methods.
func wq[T any](q *writeQueue, fn func() (T, error)) (T, error) {
	var result T
	var ferr error
	q.submit(func() { result, ferr = fn() })
	return result, ferr
}

// wq0 is like wq but for functions returning only an error.
func wq0(q *writeQueue, fn func() error) error {
	var ferr error
	q.submit(func() { ferr = fn() })
	return ferr
}
