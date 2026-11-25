<#--
  'Account already exists' — the page the brokered flow used to dead-end on. The first-broker-login flow now auto-links (KC_setup.md §5), so reaching this means the IdP is still pointed at the built-in flow.

  See bounce.ftl for why every user-facing Keycloak page redirects to the app.
-->
<#import "bounce.ftl" as bounce>
<@bounce.redirect reason="account_link_failed"/>
