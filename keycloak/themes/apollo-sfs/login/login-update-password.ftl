<#--
  Keycloak's UPDATE_PASSWORD form — what an old execute-actions-email link opens. Those links are no longer issued; send the user to the app's forgot-password modal instead.

  See bounce.ftl for why every user-facing Keycloak page redirects to the app.
-->
<#import "bounce.ftl" as bounce>
<@bounce.redirect/>
