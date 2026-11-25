<#--
  Keycloak's 'forgot password' form. The app owns that flow: POST /api/v1/auth/forgot_password emails a link to /reset-password.

  See bounce.ftl for why every user-facing Keycloak page redirects to the app.
-->
<#import "bounce.ftl" as bounce>
<@bounce.redirect/>
