<#--
  Shared redirect used by every Keycloak page a user could otherwise land on.

  All authentication UI for Apollo SFS lives in the React app: sign-in, the
  forgot-password modal, /reset-password, and the social buttons (which go
  through GET /api/v1/auth/social/start). Keycloak is an OIDC backend here, not a
  user-facing site — so the templates that would render its own login, register,
  password and account-linking screens are overridden to bounce back to the app
  instead of showing an unbranded page mid-flow.

  These overrides apply to the apollo-sfs-realm login theme only. The Keycloak
  admin console signs in against the *master* realm with its own theme and is
  unaffected — administering Keycloak at auth.apollo-sfs.com still works.

  Reaching one of these pages means a flow went somewhere it was not meant to
  (see keycloak/KC_setup.md §5), so the bounce carries a reason the login page
  can surface and that shows up in the app's access logs.
-->
<#macro redirect reason="">
<#local appUrl = properties.appUrl!"https://apollo-sfs.com">
<#local target = appUrl + "/login" + (reason?has_content)?then("?social_error=" + reason?url, "")>
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="robots" content="noindex, nofollow">
    <title>Redirecting…</title>
    <meta http-equiv="refresh" content="0; url=${target}">
    <script type="text/javascript">window.location.replace("${target}");</script>
  </head>
  <body>
    <p>Redirecting to <a href="${target}">Apollo SFS</a>…</p>
  </body>
</html>
</#macro>
