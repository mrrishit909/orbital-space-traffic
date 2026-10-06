-- ORBITAL domain tables (blueprint 01 section 5), with tenant_id, created_by, updated_at, soft delete and row-level security added
-- where rows belong to one operator. The catalog itself (space_objects, tle_sets, ephemeris_points) is shared reference data.
CREATE TABLE space_objects (
  id UUID PRIMARY KEY,
  norad_id BIGINT UNIQUE,
  cospar_id TEXT,
  name TEXT NOT NULL,
  object_type TEXT CHECK (object_type IN ('payload','rocket_body','debris','unknown')),
  operator_org_id UUID REFERENCES organizations(id),
  status TEXT,
  mass_kg NUMERIC,
  radius_m NUMERIC,
  family TEXT,                              -- (+) generator family, e.g. "aurora", "cloud-a"
  sigma_ric_m DOUBLE PRECISION[3],          -- (+) 1-sigma position uncertainty at epoch, radial/in-track/cross-track
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX space_objects_operator ON space_objects (operator_org_id);
CREATE INDEX space_objects_type ON space_objects (object_type);

CREATE TABLE tle_sets (
  id UUID PRIMARY KEY,
  space_object_id UUID REFERENCES space_objects(id),
  epoch TIMESTAMPTZ NOT NULL,
  line1 TEXT NOT NULL CHECK (length(line1) = 69),
  line2 TEXT NOT NULL CHECK (length(line2) = 69),
  source TEXT,
  ingested_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX tle_sets_object_epoch ON tle_sets (space_object_id, epoch DESC);

CREATE TABLE ephemeris_points (
  space_object_id UUID REFERENCES space_objects(id),
  ts TIMESTAMPTZ NOT NULL,
  x_km DOUBLE PRECISION, y_km DOUBLE PRECISION, z_km DOUBLE PRECISION,
  vx_kms DOUBLE PRECISION, vy_kms DOUBLE PRECISION, vz_kms DOUBLE PRECISION,
  PRIMARY KEY (space_object_id, ts)
);

CREATE TABLE conjunction_events (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+) the operator whose screening produced it
  primary_object_id UUID REFERENCES space_objects(id),
  secondary_object_id UUID REFERENCES space_objects(id),
  tca TIMESTAMPTZ NOT NULL,
  miss_distance_m DOUBLE PRECISION,
  relative_velocity_mps DOUBLE PRECISION,
  collision_probability DOUBLE PRECISION,
  risk_level TEXT CHECK (risk_level IN ('high','medium','low')),
  geometry JSONB NOT NULL,                                -- (+) states at TCA, combined covariance, hard-body radius
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX conjunction_events_tenant_tca ON conjunction_events (tenant_id, tca);

CREATE TABLE maneuvers (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),   -- (+)
  space_object_id UUID REFERENCES space_objects(id),
  conjunction_id UUID REFERENCES conjunction_events(id),  -- (+)
  requested_by UUID,
  burn_time TIMESTAMPTZ,
  dv_x DOUBLE PRECISION, dv_y DOUBLE PRECISION, dv_z DOUBLE PRECISION,  -- radial / in-track / cross-track, m/s
  simulation_only BOOLEAN DEFAULT TRUE,
  status TEXT,
  result JSONB,                                           -- (+) new miss, Pc, re-screen
  created_by TEXT, updated_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE alert_rules (                                 -- (+) behind POST /v1/alerts/rules
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),
  rule JSONB NOT NULL,
  created_by TEXT, updated_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE alert_deliveries (                            -- (+)
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),
  rule_id UUID REFERENCES alert_rules(id),
  conjunction_id UUID REFERENCES conjunction_events(id),
  channel TEXT, target TEXT, text TEXT, status TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ground_stations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, lat_deg DOUBLE PRECISION, lon_deg DOUBLE PRECISION, alt_km DOUBLE PRECISION, min_elev_deg DOUBLE PRECISION
);

CREATE TABLE client_telemetry (                            -- (+) browser Web Vitals / FPS samples
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ DEFAULT now(), sample JSONB NOT NULL
);

-- row-level security: the API connects as orbital_app (not the owner) and sets app.tenant per transaction
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbital_app') THEN CREATE ROLE orbital_app LOGIN PASSWORD 'app-dev-only'; END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO orbital_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO orbital_app;
REVOKE UPDATE, DELETE ON audit_log FROM orbital_app;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['conjunction_events','maneuvers','alert_rules','alert_deliveries','audit_log','idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant'', true)::uuid)', t);
  END LOOP;
END $$;
