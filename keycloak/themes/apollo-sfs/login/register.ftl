<#--
  Keycloak's self-registration page. Registration is invitation-only and handled at the app's /register.

  See bounce.ftl for why every user-facing Keycloak page redirects to the app.
-->
<#import "bounce.ftl" as bounce>
<@bounce.redirect reason="registration_closed"/>
