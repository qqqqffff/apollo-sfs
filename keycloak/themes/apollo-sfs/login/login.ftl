<#--
  Keycloak's own username/password page. Users sign in at the app's /login; only a hand-typed authorization URL (no kc_idp_hint) reaches this.

  See bounce.ftl for why every user-facing Keycloak page redirects to the app.
-->
<#import "bounce.ftl" as bounce>
<@bounce.redirect reason="keycloak_signin"/>
