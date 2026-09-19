-- S05 custom migration (hand-written, reviewed; D24 allows reviewed hand SQL).
--
-- The administrator flag is a manually managed database flag (PRD §3.2) with
-- NO endpoint that can set it. The only legitimate write path is direct SQL
-- by the operator, so the audit trail for "admin-flag change" security events
-- lives at the database layer: this trigger records every is_admin transition
-- into control_security_events. Event details contain only the account id and
-- the flag transition — no secrets (G3).
CREATE OR REPLACE FUNCTION control_security_admin_flag_audit() RETURNS trigger AS $$
BEGIN
  IF (NEW.is_admin IS DISTINCT FROM OLD.is_admin) THEN
    INSERT INTO control_security_events
      ("event_type", "account_id", "redaction_class", "details")
    VALUES
      ('admin_flag_changed', NEW.id, 'internal',
       jsonb_build_object(
         'account_id', NEW.id,
         'previous_is_admin', OLD.is_admin,
         'current_is_admin', NEW.is_admin));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER control_accounts_admin_flag_audit
AFTER UPDATE OF is_admin ON "control_accounts"
FOR EACH ROW EXECUTE FUNCTION control_security_admin_flag_audit();
