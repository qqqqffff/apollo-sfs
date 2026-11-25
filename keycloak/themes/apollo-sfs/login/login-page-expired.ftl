<#--
  Keycloak's 'page has expired' screen, e.g. when a brokered sign-in is left open too long. Restart from the app.

  See bounce.ftl for why every user-facing Keycloak page redirects to the app.
-->
<#import "bounce.ftl" as bounce>
<@bounce.redirect reason="session_expired"/>
