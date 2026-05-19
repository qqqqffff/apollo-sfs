# Example — Database Setup

Run `14_interest_form.sql` against the live database to create the two new tables required by the interest form feature.

## Steps

1. Connect to the database container:

```bash
docker exec -i apollo-sfs-postgresql-app psql -U $POSTGRES_APP_USER -d apollo-sfs-db \
-f /docker-entrypoint-initdb.d/14_interest_form.sql 
```

migration example
```bash
docker exec -i apollo-sfs-postgresql-app psql \
  -U $POSTGRES_APP_USER \
  -d $POSTGRES_APP_DB \
  -f /docker-entrypoint-initdb.d/migrations/006_alarm_subscriptions.sql
```
