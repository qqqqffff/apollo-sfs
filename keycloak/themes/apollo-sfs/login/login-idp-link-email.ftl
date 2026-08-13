<#--
  'Confirm linking by email' — same built-in flow as login-idp-link-confirm.

  See bounce.ftl for why every user-facing Keycloak page redirects to the app.
-->
<#import "bounce.ftl" as bounce>
<@bounce.redirect reason="account_link_failed"/>
