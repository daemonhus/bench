package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
)

// The service map: every project as a service with its features, and the connections between
// them that flows record (an edge whose two steps are on different projects). Connections with
// the same ends, kind and protocol are merged, with the flows they come from. Feature links
// (a feature linked to another, in its project or another) are listed beside them, so the map
// shows the dependencies no flow covers yet, and connections no link backs.

type ServiceMap struct {
	Services    []MapService    `json:"services"`
	Connections []MapConnection `json:"connections"`
	// Internal are the edges between features of one service, merged the same way.
	Internal []MapConnection `json:"internal"`
	// Links are the feature links, one per linked pair (links have no direction).
	Links []MapLink `json:"links"`
}

type MapService struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	// Zone is the trust zone from the project's service profile.
	Zone     string       `json:"zone,omitempty"`
	Features []MapFeature `json:"features"`
}

type MapFeature struct {
	ID           string       `json:"id"`
	Kind         string       `json:"kind"`
	Title        string       `json:"title"`
	Operation    string       `json:"operation,omitempty"`
	Protocol     string       `json:"protocol,omitempty"`
	Direction    string       `json:"direction,omitempty"`
	Status       string       `json:"status,omitempty"`
	Tags         []string     `json:"tags"`
	OpenFindings int          `json:"openFindings"`
	FlowCount    int          `json:"flowCount"`
	Flows        []MapFlowRef `json:"flows"`
	// Missing marks a feature a flow step names that the project no longer has.
	Missing bool `json:"missing,omitempty"`
	// Zone is set when the feature's "zone:<name>" tag puts it in another zone than its service.
	Zone string `json:"zone,omitempty"`
}

type MapFlowRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type MapConnection struct {
	FromProject   string   `json:"fromProject"`
	FromFeature   string   `json:"fromFeature"`
	ToProject     string   `json:"toProject"`
	ToFeature     string   `json:"toFeature"`
	Kind          string   `json:"kind"`
	Protocol      string   `json:"protocol"`
	Auth          []string `json:"auth"`
	TrustBoundary bool     `json:"trustBoundary"`
	// ZoneBoundary: the two ends sit in different trust zones.
	ZoneBoundary bool `json:"zoneBoundary,omitempty"`
	// Linked: a feature link backs the connection.
	Linked  bool         `json:"linked"`
	Tainted bool         `json:"tainted"`
	Count   int          `json:"count"`
	Flows   []MapFlowRef `json:"flows"`
}

// MapLink is a feature link: two features, in one project or two, linked to each other.
type MapLink struct {
	FromProject string `json:"fromProject"`
	FromFeature string `json:"fromFeature"`
	ToProject   string `json:"toProject"`
	ToFeature   string `json:"toFeature"`
	Description string `json:"description,omitempty"`
	// InFlows: some flow connects the two features (either way).
	InFlows bool `json:"inFlows"`
}

type mapRawFeature struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Kind      string   `json:"kind"`
	Operation string   `json:"operation"`
	Protocol  string   `json:"protocol"`
	Direction string   `json:"direction"`
	Status    string   `json:"status"`
	Tags      []string `json:"tags"`
	// LinkedFeatures name this project's features by id, other projects' as "<project>:<id>".
	LinkedFeatures []struct {
		ID          string `json:"id"`
		Description string `json:"description"`
	} `json:"linkedFeatures"`
}

type mapRawFinding struct {
	Status   string   `json:"status"`
	Features []string `json:"features"`
}

// serviceMap serves GET /api/service-map. ?archived=1 includes archived flows' edges.
func (p *Platform) serviceMap(w http.ResponseWriter, r *http.Request) {
	m, err := p.buildServiceMap(r.URL.Query().Get("archived") == "1")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, m)
}

func (p *Platform) buildServiceMap(includeArchived bool) (*ServiceMap, error) {
	rows, err := p.db.Query(`SELECT slug, name FROM projects ORDER BY name`)
	if err != nil {
		return nil, err
	}
	var services []MapService
	for rows.Next() {
		var s MapService
		rows.Scan(&s.Slug, &s.Name)
		s.Features = []MapFeature{}
		services = append(services, s)
	}
	rows.Close()

	// Each project's features and open findings, fetched in parallel.
	type rawLink struct{ fromProject, fromFeature, to, description string }
	linksOf := make([][]rawLink, len(services))
	var wg sync.WaitGroup
	for i := range services {
		wg.Add(1)
		go func(s *MapService, links *[]rawLink) {
			defer wg.Done()
			wb, err := p.getWorkbench(s.Slug)
			if err != nil {
				return
			}
			s.Zone = p.projectZone(wb)
			get := func(path string, v any) {
				rec := httptest.NewRecorder()
				wb.Handler().ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
				if rec.Code == 200 {
					json.Unmarshal(rec.Body.Bytes(), v)
				}
			}
			var feats []mapRawFeature
			var findings []mapRawFinding
			get("/api/features", &feats)
			get("/api/findings", &findings)
			open := map[string]int{}
			for _, f := range findings {
				if isOpenStatus(f.Status) {
					for _, id := range f.Features {
						open[id]++
					}
				}
			}
			for _, f := range feats {
				tags := f.Tags
				if tags == nil {
					tags = []string{}
				}
				mf := MapFeature{ID: f.ID, Kind: f.Kind, Title: f.Title, Operation: f.Operation, Protocol: f.Protocol,
					Direction: f.Direction, Status: f.Status, Tags: tags, OpenFindings: open[f.ID], Flows: []MapFlowRef{}}
				if z := featureZone(tags, ""); z != "" && !strings.EqualFold(z, s.Zone) {
					mf.Zone = z
				}
				s.Features = append(s.Features, mf)
				for _, l := range f.LinkedFeatures {
					*links = append(*links, rawLink{s.Slug, f.ID, qualifiedRef(s.Slug, l.ID), l.Description})
				}
			}
		}(&services[i], &linksOf[i])
	}
	wg.Wait()

	byService := map[string]*MapService{}
	for i := range services {
		byService[services[i].Slug] = &services[i]
	}
	feature := func(slug, id string) *MapFeature {
		s := byService[slug]
		if s == nil {
			return nil
		}
		for i := range s.Features {
			if s.Features[i].ID == id {
				return &s.Features[i]
			}
		}
		s.Features = append(s.Features, MapFeature{ID: id, Title: id, Kind: "externality", Tags: []string{}, Flows: []MapFlowRef{}, Missing: true})
		return &s.Features[len(s.Features)-1]
	}

	// Steps (with their flow) and edges of every flow in scope.
	statusCond := `f.status <> 'archived'`
	if includeArchived {
		statusCond = `1=1`
	}
	type stepRef struct{ flowID, flowName, slug, feature string }
	steps := map[string]stepRef{}
	srows, err := p.db.Query(`SELECT s.id, s.flow_id, f.name, s.project_slug, s.feature_id FROM flow_steps s JOIN flows f ON f.id = s.flow_id WHERE s.subflow_id = '' AND ` + statusCond)
	if err != nil {
		return nil, err
	}
	flowsPerFeature := map[[2]string]map[string]string{}
	for srows.Next() {
		var id string
		var ref stepRef
		srows.Scan(&id, &ref.flowID, &ref.flowName, &ref.slug, &ref.feature)
		steps[id] = ref
		k := [2]string{ref.slug, ref.feature}
		if flowsPerFeature[k] == nil {
			flowsPerFeature[k] = map[string]string{}
		}
		flowsPerFeature[k][ref.flowID] = ref.flowName
	}
	srows.Close()
	for k, flows := range flowsPerFeature {
		if f := feature(k[0], k[1]); f != nil {
			f.FlowCount = len(flows)
			for id, name := range flows {
				f.Flows = append(f.Flows, MapFlowRef{ID: id, Name: name})
			}
			sort.Slice(f.Flows, func(i, j int) bool { return f.Flows[i].Name < f.Flows[j].Name })
		}
	}

	erows, err := p.db.Query(`SELECT e.from_step_id, e.to_step_id, e.kind, e.protocol, e.auth, e.trust_boundary, e.tainted FROM flow_edges e JOIN flows f ON f.id = e.flow_id WHERE ` + statusCond)
	if err != nil {
		return nil, err
	}
	type key struct{ fp, ff, tp, tf, kind, protocol string }
	conns := map[key]*MapConnection{}
	var order []key
	for erows.Next() {
		var from, to, kind, protocol, auth string
		var tb, tainted int
		erows.Scan(&from, &to, &kind, &protocol, &auth, &tb, &tainted)
		a, b := steps[from], steps[to]
		if a.slug == "" || b.slug == "" {
			continue
		}
		k := key{a.slug, a.feature, b.slug, b.feature, kind, strings.ToLower(protocol)}
		c := conns[k]
		if c == nil {
			c = &MapConnection{FromProject: a.slug, FromFeature: a.feature, ToProject: b.slug, ToFeature: b.feature, Kind: kind, Protocol: protocol,
				Auth: []string{}, Flows: []MapFlowRef{}}
			conns[k] = c
			order = append(order, k)
		}
		c.Count++
		c.TrustBoundary = c.TrustBoundary || tb != 0
		c.Tainted = c.Tainted || tainted != 0
		if auth != "" && !contains(c.Auth, auth) {
			c.Auth = append(c.Auth, auth)
		}
		seen := false
		for _, f := range c.Flows {
			seen = seen || f.ID == a.flowID
		}
		if !seen {
			c.Flows = append(c.Flows, MapFlowRef{ID: a.flowID, Name: a.flowName})
		}
	}
	erows.Close()

	// Zones and links, for each connection's ends and for the link list.
	zoneOf := func(slug, id string) string {
		s := byService[slug]
		if s == nil {
			return ""
		}
		for _, f := range s.Features {
			if f.ID == id && f.Zone != "" {
				return f.Zone
			}
		}
		return s.Zone
	}
	pairKey := func(ap, af, bp, bf string) [4]string {
		if ap+":"+af > bp+":"+bf {
			ap, af, bp, bf = bp, bf, ap, af
		}
		return [4]string{ap, af, bp, bf}
	}
	inFlows := map[[4]string]bool{}
	for _, k := range order {
		inFlows[pairKey(k.fp, k.ff, k.tp, k.tf)] = true
	}
	linked := map[[4]string]bool{}
	m := &ServiceMap{Services: services, Connections: []MapConnection{}, Internal: []MapConnection{}, Links: []MapLink{}}
	for _, list := range linksOf {
		for _, l := range list {
			toProject, toFeature, ok := strings.Cut(l.to, ":")
			if !ok || feature(toProject, toFeature) == nil {
				continue
			}
			k := pairKey(l.fromProject, l.fromFeature, toProject, toFeature)
			if linked[k] {
				continue
			}
			linked[k] = true
			m.Links = append(m.Links, MapLink{FromProject: l.fromProject, FromFeature: l.fromFeature, ToProject: toProject, ToFeature: toFeature,
				Description: l.description, InFlows: inFlows[k]})
		}
	}
	sort.Slice(m.Links, func(i, j int) bool {
		a, b := m.Links[i], m.Links[j]
		return a.FromProject+a.FromFeature+a.ToProject+a.ToFeature < b.FromProject+b.FromFeature+b.ToProject+b.ToFeature
	})
	if m.Services == nil {
		m.Services = []MapService{}
	}
	for _, k := range order {
		c := conns[k]
		za, zb := zoneOf(c.FromProject, c.FromFeature), zoneOf(c.ToProject, c.ToFeature)
		c.ZoneBoundary = za != "" && zb != "" && !strings.EqualFold(za, zb)
		c.Linked = linked[pairKey(c.FromProject, c.FromFeature, c.ToProject, c.ToFeature)]
		sort.Strings(c.Auth)
		sort.Slice(c.Flows, func(i, j int) bool { return c.Flows[i].Name < c.Flows[j].Name })
		if c.FromProject == c.ToProject {
			m.Internal = append(m.Internal, *c)
		} else {
			m.Connections = append(m.Connections, *c)
		}
	}
	return m, nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
