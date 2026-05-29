package middleware

import (
	"log"
	"net/http"

	"github.com/casbin/casbin/v2"
	"github.com/casbin/casbin/v2/model"
	"github.com/gin-gonic/gin"
)

// Note: gin-contrib/authz v1.0.7 only supports BasicAuth subject extraction
// via its NewAuthorizer helper. We call the Casbin enforcer directly so that
// the subject can be read from the Gin context (set by RequireAuth) instead.

// casbinModel defines a simple allow-based RBAC model.
// keyMatch is used for the path so that "/api/v1/admin/*" covers all sub-paths.
const casbinModel = `
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = r.sub == p.sub && keyMatch(r.obj, p.obj) && (r.act == p.act || p.act == "*")
`

// adminSubjectFinder is the gin-contrib/authz SubjectFinder that extracts the
// Casbin subject from the Gin context. RequireAuth must run first to populate
// "roles". Returns "admin" when the role is present, "" otherwise (no policy
// will match and authz will return 403).
func adminSubjectFinder(c *gin.Context) string {
	roles, exists := c.Get("roles")
	if !exists {
		return ""
	}
	roleList, ok := roles.([]string)
	if !ok {
		return ""
	}
	for _, role := range roleList {
		if role == "admin" {
			return "admin"
		}
	}
	return ""
}

func newAdminEnforcer() *casbin.Enforcer {
	m, err := model.NewModelFromString(casbinModel)
	if err != nil {
		log.Fatalf("middleware: failed to build casbin model: %v", err)
	}
	e, err := casbin.NewEnforcer(m)
	if err != nil {
		log.Fatalf("middleware: failed to create casbin enforcer: %v", err)
	}
	// Grant the "admin" subject access to all admin paths for any HTTP method.
	// The /* pattern is safe here because this enforcer is only used on the
	// /api/v1/admin/* route group — see setupRouter in cmd/main.go.
	if _, err := e.AddPolicy("admin", "/api/v1/admin/*", "*"); err != nil {
		log.Fatalf("middleware: failed to add admin policy: %v", err)
	}
	return e
}

// RequireAdmin returns a Gin middleware that uses a Casbin RBAC enforcer to
// gate access to admin routes. It must be chained after RequireAuth so that
// "roles" is present in the Gin context.
//
// The enforcer grants the "admin" subject access to /api/v1/admin/* for any
// HTTP method. Non-admin users (or anyone whose subject resolves to "") receive
// 403 Forbidden.
func (m *AuthMiddleware) RequireAdmin() gin.HandlerFunc {
	e := newAdminEnforcer()
	return func(c *gin.Context) {
		subject := adminSubjectFinder(c)
		allowed, err := e.Enforce(subject, c.Request.URL.Path, c.Request.Method)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "authorization error"})
			return
		}
		if !allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "admin role required"})
			return
		}
		c.Next()
	}
}