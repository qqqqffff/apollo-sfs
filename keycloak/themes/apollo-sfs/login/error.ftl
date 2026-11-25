<#--
  Keycloak's generic error page — the unbranded screen shown when a brokered sign-in fails (provider cancelled, misconfigured IdP).

  See bounce.ftl for why every user-facing Keycloak page redirects to the app.
-->
<#import "bounce.ftl" as bounce>
<@bounce.redirect reason="provider_error"/>
