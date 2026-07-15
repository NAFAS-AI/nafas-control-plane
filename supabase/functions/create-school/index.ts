import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const body = await req.json()
    const {
      name_ar, name_en, country, city, system,
      grades, subdomain, admin, schedule,
      curriculum, classes_per_grade
    } = body

    // ── 1. Register school in NAFAS Control Plane (master Supabase) ──
    const NAFAS_URL = Deno.env.get('NAFAS_SB_URL') || ''
    const NAFAS_SERVICE = Deno.env.get('NAFAS_SERVICE_ROLE_KEY') || ''

    const schoolRecord = {
      name_ar, name_en, country, city,
      education_system: system,
      grade_range: grades ? grades[0]+'–'+grades[grades.length-1] : '',
      subdomain,
      status: 'provisioning',
      student_count: 0, staff_count: 0, health_score: 0,
      last_sync: null,
      created_at: new Date().toISOString(),
      admin_username: admin?.username,
      admin_email: admin?.email,
      curriculum,
      classes_per_grade,
      schedule_config: schedule
    }

    let schoolId = null
    if (NAFAS_URL && NAFAS_SERVICE) {
      const regRes = await fetch(NAFAS_URL + '/rest/v1/schools', {
        method: 'POST',
        headers: {
          'apikey': NAFAS_SERVICE,
          'Authorization': 'Bearer ' + NAFAS_SERVICE,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(schoolRecord)
      })
      if (regRes.ok) {
        const [rec] = await regRes.json()
        schoolId = rec?.id
      }
    }

    // ── 2. Create Supabase Project via Management API ──
    const MGMT_TOKEN = Deno.env.get('NAFAS_MGMT_TOKEN') || ''
    const ORG_ID = Deno.env.get('NAFAS_ORG_ID') || ''
    let newProjectRef = null
    let newAnonKey = null

    if (MGMT_TOKEN && ORG_ID) {
      const projRes = await fetch('https://api.supabase.com/v1/projects', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + MGMT_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: subdomain + '-eduos',
          organization_id: ORG_ID,
          plan: 'free',
          region: 'ap-southeast-1', // closest to UAE
          db_pass: crypto.randomUUID().replace(/-/g,'').slice(0,20) + 'Aa1!'
        })
      })
      if (projRes.ok) {
        const proj = await projRes.json()
        newProjectRef = proj.id

        // Wait for project to be ready
        await new Promise(r => setTimeout(r, 30000))

        // Get anon key
        const keysRes = await fetch(
          `https://api.supabase.com/v1/projects/${newProjectRef}/api-keys`,
          { headers: { 'Authorization': 'Bearer ' + MGMT_TOKEN } }
        )
        if (keysRes.ok) {
          const keys = await keysRes.json()
          const anonKey = keys.find((k: any) => k.name === 'anon')
          newAnonKey = anonKey?.api_key
        }
      }
    }

    // ── 2b. Inject Secrets into new project (GEMINI_API_KEY from NAFAS master) ──
    const GEMINI_MASTER_KEY = Deno.env.get('GEMINI_MASTER_KEY') || ''
    if (newProjectRef && MGMT_TOKEN && GEMINI_MASTER_KEY) {
      try {
        await fetch(`https://api.supabase.com/v1/projects/${newProjectRef}/secrets`, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + MGMT_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify([
            { name: 'GEMINI_API_KEY', value: GEMINI_MASTER_KEY }
          ])
        })
      } catch (_) { /* non-fatal — log but continue */ }
    }

    // ── 3. Apply Schema to new project ──
    const GH_TOKEN = Deno.env.get('SYNC_TOKEN') || ''
    if (newProjectRef && MGMT_TOKEN) {
      const schema = await buildEduOSSchema(subdomain, admin, grades, schedule, GH_TOKEN)
      await fetch(`https://api.supabase.com/v1/projects/${newProjectRef}/database/query`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + MGMT_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: schema })
      })
    }

    // ── 4. Create GitHub Repo from template ──
    const GH_ORG = 'NAFAS-AI'
    const GH_TEMPLATE = 'eduos-core'

    if (GH_TOKEN) {
      // Create repo from template
      await fetch(`https://api.github.com/repos/${GH_ORG}/${GH_TEMPLATE}/generate`, {
        method: 'POST',
        headers: {
          'Authorization': 'token ' + GH_TOKEN,
          'Accept': 'application/vnd.github.baptiste-preview+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          owner: GH_ORG,
          name: 'school-' + subdomain,
          description: name_en + ' — EduOS',
          private: true
        })
      })

      // Add school-specific config
      if (newProjectRef && newAnonKey) {
        const configContent = btoa(`
window.EduOS = window.EduOS || {};
window.EduOS.SB_URL = 'https://${newProjectRef}.supabase.co';
window.EduOS_k1 = '${newAnonKey.slice(0, 40)}';
window.EduOS_k2 = '${newAnonKey.slice(40, 80)}';
window.EduOS_k3 = '${newAnonKey.slice(80)}';
window.EduOS.SCHOOL_ID = '${subdomain}';
window.EduOS.SCHOOL_NAME_AR = '${name_ar}';
window.EduOS.SCHOOL_NAME_EN = '${name_en}';
window.EduOS.COUNTRY = '${country}';
window.EduOS.EDU_SYSTEM = '${system}';
        `.trim())

        await fetch(
          `https://api.github.com/repos/${GH_ORG}/school-${subdomain}/contents/apps/platform-config.js`,
          {
            method: 'PUT',
            headers: {
              'Authorization': 'token ' + GH_TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              message: 'chore: inject school config for ' + subdomain,
              content: configContent
            })
          }
        )
      }
    }

    // ── 5. Update school record to active ──
    if (schoolId && NAFAS_URL && NAFAS_SERVICE) {
      await fetch(NAFAS_URL + '/rest/v1/schools?id=eq.' + schoolId, {
        method: 'PATCH',
        headers: {
          'apikey': NAFAS_SERVICE,
          'Authorization': 'Bearer ' + NAFAS_SERVICE,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status: 'active',
          supabase_ref: newProjectRef,
          github_repo: newProjectRef ? 'school-' + subdomain : null,
          health_score: 100,
          last_sync: new Date().toISOString()
        })
      })
    }

    return new Response(JSON.stringify({
      success: true,
      school_id: schoolId,
      subdomain,
      url: `https://${subdomain}.eduos.ae/apps/`,
      supabase_ref: newProjectRef,
      message: 'تم إنشاء المدرسة بنجاح'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    })

  } catch (err) {
    return new Response(JSON.stringify({
      success: false,
      error: err.message
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    })
  }
})

// ── Schema Builder ──
// Fetches canonical schema from eduos-core GitHub, falls back to minimal inline schema
async function buildEduOSSchema(
  subdomain: string, admin: any, grades: string[], schedule: any, ghToken: string
): Promise<string> {
  // Try to fetch the canonical 248-table schema from eduos-core
  let canonicalSchema = ''
  if (ghToken) {
    try {
      const schemaRes = await fetch(
        'https://raw.githubusercontent.com/NAFAS-AI/eduos-core/main/supabase/schema.sql',
        { headers: { 'Authorization': 'token ' + ghToken } }
      )
      if (schemaRes.ok) {
        canonicalSchema = await schemaRes.text()
      }
    } catch (_) { /* fallback below */ }
  }

  // Admin account insert (safe — uses parameterised-style quoting)
  const adminUsername = (admin?.username || 'admin').replace(/'/g, "''")
  const adminNameAr   = (admin?.name_ar  || 'مدير المدرسة').replace(/'/g, "''")
  const adminNameEn   = (admin?.name_en  || 'School Principal').replace(/'/g, "''")
  const adminEmail    = (admin?.email    || '').replace(/'/g, "''")

  const adminInsert = `
-- ── Bootstrap: admin account ──────────────────────────────────────
INSERT INTO staff_profiles (
  username, password_hash, name_ar, name_en,
  role_key, email, is_active, school_id, staff_db_id, staff_id
)
SELECT
  '${adminUsername}',
  encode(sha256('${admin?.password?.replace(/'/g, "''")||'changeme'}'::bytea), 'hex'),
  '${adminNameAr}',
  '${adminNameEn}',
  'principal',
  '${adminEmail}',
  true,
  '${subdomain}',
  'A001',
  'A001'
WHERE NOT EXISTS (
  SELECT 1 FROM staff_profiles WHERE username = '${adminUsername}'
);

-- ── Bootstrap: app_settings ───────────────────────────────────────
INSERT INTO app_settings (key, value) VALUES
  ('school_name_ar', '${(admin?.name_ar||subdomain).replace(/'/g,"''")}'),
  ('school_id',      '${subdomain}'),
  ('edu_system',     '${(grades?.[0]||'UAE').replace(/'/g,"''")}'),
  ('grades',         '${(grades?.join(',')||'').replace(/'/g,"''")}'),
  ('term_count',     '${schedule?.term_count || 2}'),
  ('academic_year',  '2025-2026')
ON CONFLICT (key) DO NOTHING;

-- ── Bootstrap: platform_state ─────────────────────────────────────
INSERT INTO platform_state (school_id, state, label_ar, label_en, is_active)
SELECT '${subdomain}', 'normal_school_day', 'يوم دراسي عادي', 'Normal School Day', true
WHERE NOT EXISTS (SELECT 1 FROM platform_state WHERE school_id = '${subdomain}');
`

  if (canonicalSchema) {
    // canonical schema already has IF NOT EXISTS — safe to run on any fresh project
    return canonicalSchema + '\n' + adminInsert
  }

  // ── Minimal fallback schema (correct column names, used only if GitHub unreachable) ──
  return `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Core tables with CORRECT column names (EduOS canonical)
CREATE TABLE IF NOT EXISTS staff_profiles (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  staff_id         text,
  staff_db_id      text,
  username         text UNIQUE,
  password_hash    text,
  name_ar          text NOT NULL,
  name_en          text,
  role_key         text,
  role_title_ar    text,
  email            text,
  phone            text,
  department       text,
  school_id        text DEFAULT '${subdomain}',
  is_active        boolean DEFAULT true,
  last_login       timestamptz,
  force_password_change boolean DEFAULT true,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS students (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  grade           text NOT NULL,
  class_name      text NOT NULL,
  student_number  text UNIQUE,
  national_id     text,
  gender          text,
  parent_phone    text,
  parent_national_id text,
  school_id       text DEFAULT '${subdomain}',
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parent_credentials (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  national_id text NOT NULL UNIQUE,
  phone       text,
  password_hash text,
  student_ids text[],
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parents (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  national_id text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name_ar     text,
  name_en     text,
  email       text,
  phone       text,
  nationality text,
  relationship text,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_grades (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id    text DEFAULT '${subdomain}',
  grade        text NOT NULL,
  section      text NOT NULL,
  student_name text NOT NULL,
  subject      text,
  term         integer NOT NULL,
  formative    numeric,
  summative    numeric,
  sb1          numeric,
  effort       integer,
  term_total   numeric,
  academic_year text DEFAULT '2025-2026',
  teacher_staff_db_id text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_attendance (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id      text NOT NULL,
  class_name      text NOT NULL,
  date            date NOT NULL,
  status          text DEFAULT 'present',
  attendance_type text DEFAULT 'physical',
  recorded_by     text,
  recorded_at     timestamptz DEFAULT now(),
  notes           text
);

CREATE TABLE IF NOT EXISTS teacher_schedule (
  id          bigserial PRIMARY KEY,
  teacher_id  text,
  teacher_name text,
  day         text,
  period      integer,
  class_name  text,
  subject     text,
  grade       text,
  school_id   text DEFAULT '${subdomain}'
);

CREATE TABLE IF NOT EXISTS schedules (
  id           serial PRIMARY KEY,
  teacher_id   text,
  teacher_name text NOT NULL,
  day          text NOT NULL,
  period       integer NOT NULL,
  class_name   text NOT NULL,
  subject      text NOT NULL,
  grade        text NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key          text PRIMARY KEY,
  value        text NOT NULL,
  updated_at   timestamptz DEFAULT now(),
  modules      jsonb DEFAULT '{"umq":false,"midad":false,"nafas":false}'
);

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id      text NOT NULL,
  user_id        text,
  role_key       text,
  feature        text NOT NULL,
  model          text DEFAULT 'gemini-2.0-flash',
  prompt_tokens  integer DEFAULT 0,
  output_tokens  integer DEFAULT 0,
  total_tokens   integer DEFAULT 0,
  cost_usd       numeric(10,6) DEFAULT 0,
  status         text DEFAULT 'success',
  created_at     timestamptz DEFAULT now()
);
ALTER TABLE ai_usage_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_read_ai_usage_log ON ai_usage_log FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS platform_state (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id      text,
  state          text NOT NULL DEFAULT 'normal_school_day',
  sub_state      text,
  label_ar       text,
  label_en       text,
  icon           text DEFAULT '🏫',
  is_active      boolean DEFAULT true,
  valid_from     timestamptz DEFAULT now(),
  valid_until    timestamptz,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id             bigserial PRIMARY KEY,
  title          text NOT NULL,
  content        text NOT NULL,
  broadcast_type text DEFAULT 'all',
  priority       text DEFAULT 'normal',
  channels       text[] DEFAULT ARRAY['app'],
  is_sent        boolean DEFAULT false,
  sent_at        timestamptz,
  created_by     text,
  created_at     timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nurse_visits (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_name text NOT NULL,
  class_name   text,
  grade_level  text,
  visit_date   date DEFAULT CURRENT_DATE,
  visit_time   time DEFAULT CURRENT_TIME,
  symptoms     text,
  action_taken text,
  outcome      text DEFAULT 'راحة',
  medicine_given text,
  notes        text,
  nurse_name   text,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title        text NOT NULL,
  location     text NOT NULL,
  category     text DEFAULT 'كهرباء',
  priority     text DEFAULT 'عادي',
  status       text DEFAULT 'مفتوح',
  description  text,
  reported_by  text,
  assigned_to  text,
  completed_at timestamptz,
  created_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS security_incidents (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  incident_type  text NOT NULL,
  description    text NOT NULL,
  location       text,
  reported_by    text,
  severity       text DEFAULT 'low',
  status         text DEFAULT 'open',
  incident_time  timestamptz DEFAULT now(),
  created_at     timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS social_cases (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_name  text NOT NULL,
  student_id    text,
  class_name    text,
  case_type     text,
  priority      text DEFAULT 'عادي',
  description   text,
  status        text DEFAULT 'مفتوح',
  assigned_to   text,
  follow_up_date date,
  notes         text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS behavior_incidents (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id          text NOT NULL,
  student_name        text,
  grade               text,
  class_name          text,
  degree              integer NOT NULL,
  violation_type      text,
  description         text,
  action_taken        text,
  teacher_id          text,
  teacher_name        text,
  specialist_notified boolean DEFAULT false,
  parent_notified     boolean DEFAULT false,
  status              text DEFAULT 'open',
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS library_books (
  id               bigserial PRIMARY KEY,
  title            text NOT NULL,
  author           text,
  category         text DEFAULT 'story',
  grade_level      text DEFAULT 'all',
  total_copies     integer DEFAULT 1,
  available_copies integer DEFAULT 1,
  created_at       timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS library_loans (
  id            bigserial PRIMARY KEY,
  book_id       bigint,
  student_name  text NOT NULL,
  class_name    text,
  borrowed_date date DEFAULT CURRENT_DATE,
  due_date      date NOT NULL,
  returned_date date,
  status        text DEFAULT 'borrowed',
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leaves (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  staff_id      text NOT NULL,
  staff_name    text,
  leave_type    text NOT NULL,
  date_from     date NOT NULL,
  date_to       date,
  duration_days numeric,
  reason        text,
  status        text DEFAULT 'pending',
  approved_by   text,
  approved_at   timestamptz,
  notes         text,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_health_records (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_name      text NOT NULL,
  class_name        text,
  allergies         text,
  chronic_conditions text,
  medications       text,
  emergency_contact text,
  blood_type        text,
  notes             text,
  updated_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schedule_templates (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name             text,
  start_time       text,
  end_time         text,
  period_duration  integer,
  periods_per_day  integer,
  break_duration   integer,
  break_after      integer,
  work_days        text[],
  is_active        boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS vark_results (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id  text,
  class_name  text,
  visual      integer DEFAULT 0,
  auditory    integer DEFAULT 0,
  reading     integer DEFAULT 0,
  kinesthetic integer DEFAULT 0,
  dominant    text,
  taken_at    timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE staff_profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE students             ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_credentials   ENABLE ROW LEVEL SECURITY;
ALTER TABLE parents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_grades       ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_attendance   ENABLE ROW LEVEL SECURITY;

-- Policies: anon can read non-sensitive tables; sensitive go through EF only
CREATE POLICY anon_staff_read     ON staff_profiles    FOR SELECT USING (true);
CREATE POLICY anon_students_deny  ON students          FOR SELECT USING (false);
CREATE POLICY anon_parents_deny   ON parent_credentials FOR SELECT USING (false);

${adminInsert}
  `
}
