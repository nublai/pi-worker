package b2

import (
	"encoding/json"
	"fmt"
)

// UnknownEvent is a frame whose type this client does not know (a newer worker). It is passed through, never dropped.
type UnknownEvent struct {
	Type string
	Raw  json.RawMessage
}

// DecodeEvent decodes one SSE data payload (an EventFrame) into its typed model, selected by "type". The union is
// decoded by hand: oapi-codegen's union helpers would need its runtime package (EventFrame is excluded from the
// models). The returned value is a pointer to one of the *Event models or an *UnknownEvent.
func DecodeEvent(data []byte) (any, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("b2: event frame: %w", err)
	}
	var target any
	switch head.Type {
	case "snapshot":
		target = &SnapshotEvent{}
	case "overflow":
		target = &OverflowEvent{}
	case "worker.updated":
		target = &WorkerUpdatedEvent{}
	case "session.rebound":
		target = &SessionReboundEvent{}
	case "execution.settled":
		target = &ExecutionSettledEvent{}
	case "fence.resolved":
		target = &FenceResolvedEvent{}
	case "interactions.changed":
		target = &InteractionsChangedEvent{}
	case "child.reported":
		target = &ChildReportedEvent{}
	case "history.appended":
		target = &HistoryAppendedEvent{}
	case "":
		return nil, fmt.Errorf("b2: event frame without a type")
	default:
		return &UnknownEvent{Type: head.Type, Raw: append(json.RawMessage(nil), data...)}, nil
	}
	if err := json.Unmarshal(data, target); err != nil {
		return nil, fmt.Errorf("b2: %s frame: %w", head.Type, err)
	}
	return target, nil
}
