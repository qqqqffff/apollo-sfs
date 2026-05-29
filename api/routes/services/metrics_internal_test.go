package services

import "testing"

// parsePingOutput is exercised here because it is unexported — parsing is the
// only logic worth unit-testing in the ping collector.

func TestParsePingOutput_NominalCase(t *testing.T) {
	// Typical Linux quiet-mode output (ping -c 5 -i 0.2 -W 1 -q 8.8.8.8).
	out := `PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.

--- 8.8.8.8 ping statistics ---
5 packets transmitted, 5 received, 0% packet loss, time 800ms
rtt min/avg/max/mdev = 5.123/14.300/22.456/1.234 ms
`
	pingMs, loss := parsePingOutput(out)
	if pingMs == nil {
		t.Fatal("expected pingMs, got nil")
	}
	if *pingMs != 14.300 {
		t.Errorf("expected avg 14.300, got %f", *pingMs)
	}
	if loss == nil {
		t.Fatal("expected loss, got nil")
	}
	if *loss != 0.0 {
		t.Errorf("expected 0%% loss, got %f", *loss)
	}
}

func TestParsePingOutput_PacketLoss(t *testing.T) {
	out := `PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.

--- 8.8.8.8 ping statistics ---
5 packets transmitted, 4 received, 20% packet loss, time 801ms
rtt min/avg/max/mdev = 5.000/6.250/9.000/1.500 ms
`
	pingMs, loss := parsePingOutput(out)
	if loss == nil {
		t.Fatal("expected loss, got nil")
	}
	if *loss != 20.0 {
		t.Errorf("expected 20%% loss, got %f", *loss)
	}
	if pingMs == nil {
		t.Fatal("expected pingMs, got nil")
	}
	if *pingMs != 6.250 {
		t.Errorf("expected avg 6.250, got %f", *pingMs)
	}
}

func TestParsePingOutput_TotalLoss(t *testing.T) {
	// All packets lost — no rtt line is printed.
	out := `PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.

--- 8.8.8.8 ping statistics ---
5 packets transmitted, 0 received, 100% packet loss, time 4000ms
`
	pingMs, loss := parsePingOutput(out)
	if loss == nil {
		t.Fatal("expected loss, got nil")
	}
	if *loss != 100.0 {
		t.Errorf("expected 100%% loss, got %f", *loss)
	}
	if pingMs != nil {
		t.Errorf("expected nil pingMs when all packets lost, got %f", *pingMs)
	}
}

func TestParsePingOutput_FractionalLoss(t *testing.T) {
	out := `5 packets transmitted, 4 received, 20.0% packet loss, time 801ms
rtt min/avg/max/mdev = 1.000/2.000/3.000/0.500 ms
`
	_, loss := parsePingOutput(out)
	if loss == nil || *loss != 20.0 {
		t.Errorf("expected 20.0%% loss, got %v", loss)
	}
}

func TestParsePingOutput_EmptyString(t *testing.T) {
	pingMs, loss := parsePingOutput("")
	if pingMs != nil || loss != nil {
		t.Errorf("expected both nil for empty input, got pingMs=%v loss=%v", pingMs, loss)
	}
}

func TestParsePingOutput_MalformedOutput(t *testing.T) {
	pingMs, loss := parsePingOutput("connection refused\n")
	if pingMs != nil || loss != nil {
		t.Errorf("expected both nil for malformed input, got pingMs=%v loss=%v", pingMs, loss)
	}
}
