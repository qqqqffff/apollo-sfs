package admin

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/gin-gonic/gin"
)

// Shutdown handles POST /admin/system/shutdown.
// It responds immediately, then triggers a full system shutdown:
//   1. Graceful HTTP drain (via shutdownCh → main).
//   2. Escapes the container cgroup so the shutdown process survives
//      `docker compose down` stopping this container.
//   3. Enters host namespaces via nsenter and runs:
//        docker compose down --timeout 60
//        poweroff
//
// Requires the container to run with privileged: true and user: root,
// and /var/run/docker.sock mounted. See docker-compose.yml.
func (h *Handler) Shutdown(c *gin.Context) {
	if h.shutdownCh == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "kill switch not configured"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "server is shutting down"})
	h.shutdownOnce.Do(func() {
		close(h.shutdownCh)
		go performSystemShutdown()
	})
}

// performSystemShutdown waits for in-flight requests to drain, then escapes
// the container cgroup and runs docker compose down + poweroff on the host.
func performSystemShutdown() {
	// Give the HTTP server time to drain open connections.
	time.Sleep(5 * time.Second)

	project := os.Getenv("COMPOSE_PROJECT_NAME")
	if project == "" {
		project = "apollo-sfs"
	}

	// The shell script does three things:
	//
	// 1. Cgroup escape — moves this process out of the container's cgroup into
	//    the host root cgroup. Without this, Docker's container teardown (which
	//    kills all processes in the container cgroup) would kill us before we
	//    can power off the host. Tries both cgroup v2 and v1 paths.
	//
	// 2. nsenter — re-executes in the host's mount, UTS, IPC, network, and PID
	//    namespaces. From that point on we see the host filesystem and process
	//    tree, so `docker` and `poweroff` refer to the host binaries.
	//
	// 3. docker compose down → poweroff — stops the stack gracefully (including
	//    our own container), then powers off the machine.
	script := fmt.Sprintf(`
for cg in /sys/fs/cgroup/cgroup.procs \
           /sys/fs/cgroup/memory/cgroup.procs \
           /sys/fs/cgroup/cpu,cpuacct/cgroup.procs; do
    [ -w "$cg" ] && echo $$ > "$cg" 2>/dev/null && break
done
exec nsenter -t 1 -m -u -i -n -p -- sh -c \
    'docker compose -p %s down --timeout 60; poweroff'
`, project)

	cmd := exec.Command("sh", "-c", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		// If we reach here the escape/nsenter failed — log and bail out.
		log.Printf("system shutdown failed: %v — output: %s", err, out)
	}
}
