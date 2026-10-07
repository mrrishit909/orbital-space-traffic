-- Pooled connections can come back with app.tenant = '' (set_config(..., true) resets to an empty string, not NULL), and
-- ''::uuid raises. Treat an empty tenant as "no tenant": the policy then matches no rows instead of erroring.
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['conjunction_events','maneuvers','alert_rules','alert_deliveries','audit_log','idempotency_keys'] LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid)', t);
  END LOOP;
END $$;
