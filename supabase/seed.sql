-- ============================================================================
-- Seed: fictional development data for תיכון החממה staff app.
--
-- ALL people/students are FICTIONAL. No real school data.
-- Domain `chamama.example` is a reserved example domain.
-- Dev password for every seeded user: Chamama2026!
-- (only usable in local dev; hosted projects usually disable password login)
--
-- Identity model: `profiles` is the application staff directory. Staff exist
-- BEFORE login (auth_user_id NULL); seeded staff are linked to their seeded
-- auth.users rows. Re-runnable: deletes its own previous records first.
-- `supabase db reset` applies migrations then runs this file automatically.
-- ============================================================================

begin;

-- ---------------------------------------------------------------- wipe ------
delete from public.profiles where email like '%@chamama.example'; -- cascades roles/assignments/messages/reads
delete from public.students
 where id between '44444444-4444-4444-4444-444444444401'
              and '44444444-4444-4444-4444-444444444450';
delete from public.greenhouse_groups
 where name in ('קבוצת זית', 'קבוצת שקד', 'קבוצת רימון', 'קבוצת דקל');
delete from public.majors
 where name in ('מגמת תקשורת', 'מגמת ביוטכנולוגיה', 'מגמת מדעי המחשב');
delete from auth.users where email like '%@chamama.example';

-- ------------------------------------------------ auth.users (auth only) ----
-- NOTE: profiles are NOT auto-created; they are inserted explicitly below
-- with a stable staff UUID and auth_user_id link.
insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password,
   email_confirmed_at, created_at, updated_at,
   confirmation_token, recovery_token, email_change_token_new, email_change_token_current, email_change,
   raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111101', 'authenticated', 'authenticated', 'ronen@chamama.example',  crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"רונן אדמיניסטרטור"}'),
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111102', 'authenticated', 'authenticated', 'michal@chamama.example', crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"מיכל שרון"}'),
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111103', 'authenticated', 'authenticated', 'yoav@chamama.example',   crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"יואב לוי"}'),
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111104', 'authenticated', 'authenticated', 'naama@chamama.example',  crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"נעמה פרץ"}'),
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111105', 'authenticated', 'authenticated', 'itay@chamama.example',   crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"איתי גפן"}'),
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111106', 'authenticated', 'authenticated', 'roni@chamama.example',   crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"רוני מזרחי"}'),
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111107', 'authenticated', 'authenticated', 'shira@chamama.example',  crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"שירה אלמוג"}'),
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111108', 'authenticated', 'authenticated', 'amit@chamama.example',   crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"עמית דהן"}'),
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111109', 'authenticated', 'authenticated', 'liat@chamama.example',   crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"ליאת נחום"}'),
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-11111111110a', 'authenticated', 'authenticated', 'tom@chamama.example',    crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"תום בר"}'),
  ('00000000-0000-0000-0000-000000000000', '99999999-9999-9999-9999-999999999901', 'authenticated', 'authenticated', 'dana@chamama.example',   crypt('Chamama2026!', gen_salt('bf')), now(), now(), now(), '', '', '', '', '', '{"provider":"google","providers":["google"]}', '{"full_name":"דנה אביבי"}');

-- ------------------------------------------- staff directory (profiles) -----
-- Stable staff UUIDs. Seeded staff are linked to their auth rows;
-- דנה is deactivated (allowlist-style `is_active=false`).
-- אבי גרוס demonstrates a pre-login staff member (auth_user_id NULL).
insert into public.profiles (id, email, full_name, is_active, auth_user_id) values
  ('11111111-1111-1111-1111-111111111101', 'ronen@chamama.example',  'רונן אדמיניסטרטור', true,  '11111111-1111-1111-1111-111111111101'),
  ('11111111-1111-1111-1111-111111111102', 'michal@chamama.example', 'מיכל שרון',        true,  '11111111-1111-1111-1111-111111111102'),
  ('11111111-1111-1111-1111-111111111103', 'yoav@chamama.example',   'יואב לוי',         true,  '11111111-1111-1111-1111-111111111103'),
  ('11111111-1111-1111-1111-111111111104', 'naama@chamama.example',  'נעמה פרץ',         true,  '11111111-1111-1111-1111-111111111104'),
  ('11111111-1111-1111-1111-111111111105', 'itay@chamama.example',   'איתי גפן',         true,  '11111111-1111-1111-1111-111111111105'),
  ('11111111-1111-1111-1111-111111111106', 'roni@chamama.example',   'רוני מזרחי',       true,  '11111111-1111-1111-1111-111111111106'),
  ('11111111-1111-1111-1111-111111111107', 'shira@chamama.example',  'שירה אלמוג',       true,  '11111111-1111-1111-1111-111111111107'),
  ('11111111-1111-1111-1111-111111111108', 'amit@chamama.example',   'עמית דהן',         true,  '11111111-1111-1111-1111-111111111108'),
  ('11111111-1111-1111-1111-111111111109', 'liat@chamama.example',   'ליאת נחום',        true,  '11111111-1111-1111-1111-111111111109'),
  ('11111111-1111-1111-1111-11111111110a', 'tom@chamama.example',    'תום בר',           true,  '11111111-1111-1111-1111-11111111110a'),
  ('11111111-1111-1111-1111-11111111110b', 'dana@chamama.example',   'דנה אביבי (מושבית)', false, '99999999-9999-9999-9999-999999999901'),
  ('11111111-1111-1111-1111-11111111110c', 'avi@chamama.example',    'אבי גרוס (טרם התחבר)', true, null);

-- ------------------------------------------------------------ user_roles ----
insert into public.user_roles (staff_id, role) values
  ('11111111-1111-1111-1111-111111111101', 'super_admin'),
  ('11111111-1111-1111-1111-111111111102', 'mentor'),
  ('11111111-1111-1111-1111-111111111103', 'mentor'),
  ('11111111-1111-1111-1111-111111111104', 'master'),
  ('11111111-1111-1111-1111-111111111104', 'staff'),
  ('11111111-1111-1111-1111-111111111105', 'master'),   -- מאסטר + מנטור (מבחן קדימות)
  ('11111111-1111-1111-1111-111111111105', 'mentor'),
  ('11111111-1111-1111-1111-111111111106', 'major_head'),
  ('11111111-1111-1111-1111-111111111106', 'staff'),
  ('11111111-1111-1111-1111-111111111107', 'counselor'),
  ('11111111-1111-1111-1111-111111111108', 'project_coordinator'),
  ('11111111-1111-1111-1111-111111111109', 'leadership'), -- הנהלה + ראש מגמה (מבחן קדימות)
  ('11111111-1111-1111-1111-111111111109', 'major_head'),
  ('11111111-1111-1111-1111-11111111110a', 'staff'),
  ('11111111-1111-1111-1111-11111111110c', 'mentor');     -- תפקיד שהוקצה לפני התחברות ראשונה

-- --------------------------------------------------------------- groups -----
insert into public.greenhouse_groups (id, name) values
  ('22222222-2222-2222-2222-222222222201', 'קבוצת זית'),
  ('22222222-2222-2222-2222-222222222202', 'קבוצת שקד'),
  ('22222222-2222-2222-2222-222222222203', 'קבוצת רימון'),
  ('22222222-2222-2222-2222-222222222204', 'קבוצת דקל');

-- --------------------------------------------------------------- majors -----
insert into public.majors (id, name) values
  ('33333333-3333-3333-3333-333333333301', 'מגמת תקשורת'),
  ('33333333-3333-3333-3333-333333333302', 'מגמת ביוטכנולוגיה'),
  ('33333333-3333-3333-3333-333333333303', 'מגמת מדעי המחשב');

-- ------------------------------------------------------------- students -----
insert into public.students (id, first_name, last_name, group_id, major_id) values
  ('44444444-4444-4444-4444-444444444401', 'נועם',  'אבידן',    '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301'),
  ('44444444-4444-4444-4444-444444444402', 'טליה',  'ברקוביץ',  '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333302'),
  ('44444444-4444-4444-4444-444444444403', 'עומר',  'גולן',     '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301'),
  ('44444444-4444-4444-4444-444444444404', 'מאיה',  'דרורי',    '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333303'),
  ('44444444-4444-4444-4444-444444444405', 'ליאו',  'הלוי',     '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333301'),
  ('44444444-4444-4444-4444-444444444406', 'שחר',   'ויסמן',    '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302'),
  ('44444444-4444-4444-4444-444444444407', 'רותם',  'זוהר',     '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333301'),
  ('44444444-4444-4444-4444-444444444408', 'אורי',  'חדד',      '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333303'),
  ('44444444-4444-4444-4444-444444444409', 'אופק',  'טל',       '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333301'),
  ('44444444-4444-4444-4444-44444444440a', 'נגה',   'יפה',      '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333302'),
  ('44444444-4444-4444-4444-44444444440b', 'אריאל', 'כץ',       '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303'),
  ('44444444-4444-4444-4444-44444444440c', 'שיר',   'זמיר',     '22222222-2222-2222-2222-222222222203', null),
  ('44444444-4444-4444-4444-44444444440d', 'יונתן', 'לביא',     '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333301'),
  ('44444444-4444-4444-4444-44444444440e', 'תהל',   'מוסקל',    '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333302'),
  ('44444444-4444-4444-4444-44444444440f', 'גיל',   'נוימן',    '22222222-2222-2222-2222-222222222204', null),
  ('44444444-4444-4444-4444-444444444450', 'קורל',  'סעדה',     '22222222-2222-2222-2222-222222222204', null);

-- ---------------------------------------------------- mentor assignments ----
insert into public.group_mentors (group_id, staff_id) values
  ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111102'), -- מיכל → זית
  ('22222222-2222-2222-2222-222222222204', '11111111-1111-1111-1111-111111111102'), -- מיכל → דקל
  ('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111103'), -- יואב → שקד
  ('22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111105'), -- איתי → רימון
  ('22222222-2222-2222-2222-222222222204', '11111111-1111-1111-1111-11111111110c'); -- אבי (טרם התחבר) → דקל

-- ------------------------------------------------------ major head roles ----
insert into public.major_heads (major_id, staff_id) values
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111106'), -- רוני → תקשורת
  ('33333333-3333-3333-3333-333333333302', '11111111-1111-1111-1111-111111111109'); -- ליאת → ביוטכנולוגיה

-- --------------------------------------------------- master assignments -----
insert into public.master_assignments (student_id, staff_id) values
  ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111104'), -- נעמה → נועם
  ('44444444-4444-4444-4444-444444444405', '11111111-1111-1111-1111-111111111104'), -- נעמה → ליאו
  ('44444444-4444-4444-4444-444444444409', '11111111-1111-1111-1111-111111111104'), -- נעמה → אופק
  ('44444444-4444-4444-4444-444444444406', '11111111-1111-1111-1111-111111111105'), -- איתי → שחר
  ('44444444-4444-4444-4444-44444444440b', '11111111-1111-1111-1111-111111111105'), -- איתי → אריאל
  ('44444444-4444-4444-4444-44444444440d', '11111111-1111-1111-1111-11111111110c'); -- אבי (טרם התחבר) → יונתן

-- ------------------------------------------------------------- messages -----
insert into public.student_messages
  (id, student_id, author_staff_id, body, created_at, is_general_visible,
   general_visible_by, general_visible_at, is_hidden_from_leads,
   restriction_changed_by, restriction_changed_at)
values
  -- נועם (זית / תקשורת, master=נעמה, mentor=מיכל)
  ('55555555-5555-5555-5555-555555555501', '44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111102',
   'נועם פתח אתמול את הפרויקט האישי שלו — התחיל בחקר נושא והראה מוטיבציה גבוהה.', now() - interval '9 days', true,
   '11111111-1111-1111-1111-111111111102', now() - interval '8 days', false, null, null),
  ('55555555-5555-5555-5555-555555555502', '44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111104',
   'מפגש מאסטר שבועי: עברנו על מבנה העבודה, נקבעו יעדים לשבוע הבא.', now() - interval '6 days', false, null, null, false, null, null),
  ('55555555-5555-5555-5555-555555555503', '44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111102',
   'שיחה אישית רגישה עם נועם — לפרטים רק בערוץ המנטורים. אנא לא להפיץ.', now() - interval '2 days', false, null, null, true,
   '11111111-1111-1111-1111-111111111102', now() - interval '2 days'),
  -- ליאו (שקד / תקשורת, master=נעמה, mentor=יואב)
  ('55555555-5555-5555-5555-555555555504', '44444444-4444-4444-4444-444444444405', '11111111-1111-1111-1111-111111111106',
   'ליאו סיים את שלב הצילומים הראשון. תוצרים מרשימים במיוחד.', now() - interval '5 days', false, null, null, false, null, null),
  -- מאיה (זית / מדמ"ח)
  ('55555555-5555-5555-5555-555555555505', '44444444-4444-4444-4444-444444444404', '11111111-1111-1111-1111-11111111110a',
   'צוות כללי: מאיה תעבוד עם ספריית עיבוד תמונה בפרויקט שלה.', now() - interval '4 days', false, null, null, false, null, null),
  -- שחר (שקד / ביוטכנולוגיה, master=איתי, mentor=יואב)
  ('55555555-5555-5555-5555-555555555506', '44444444-4444-4444-4444-444444444406', '11111111-1111-1111-1111-111111111107',
   'קבעתי שיחת מעקב עם שחר ליום חמישי. נעדכן אחרי.', now() - interval '4 days', false, null, null, false, null, null),
  ('55555555-5555-5555-5555-555555555507', '44444444-4444-4444-4444-444444444406', '11111111-1111-1111-1111-111111111103',
   'שחר הגיש את הדוח הראשון בזמן — כל הכבוד!', now() - interval '3 days', true,
   '11111111-1111-1111-1111-111111111103', now() - interval '3 days', false, null, null),
  ('55555555-5555-5555-5555-555555555508', '44444444-4444-4444-4444-444444444406', '11111111-1111-1111-1111-111111111103',
   'עדכון אישי על שחר — מיועד למנטור בלבד, מוסתר ממאסטרים וראשי מגמה.', now() - interval '1 day', false, null, null, true,
   '11111111-1111-1111-1111-111111111103', now() - interval '1 day'),
  -- אריאל (רימון / מדמ"ח, master=איתי, mentor=איתי)
  ('55555555-5555-5555-5555-555555555509', '44444444-4444-4444-4444-44444444440b', '11111111-1111-1111-1111-111111111105',
   'אריאל התחיל לבנות את האב-טיפוס. התקדמות מצוינת.', now() - interval '7 days', true,
   '11111111-1111-1111-1111-111111111105', now() - interval '7 days', false, null, null),
  ('55555555-5555-5555-5555-55555555550a', '44444444-4444-4444-4444-44444444440b', '11111111-1111-1111-1111-111111111105',
   'הערה פרטנית לעצמי לגבי אריאל — לבדוק שוב בשבוע הבא.', now() - interval '8 hours', false, null, null, false, null, null),
  -- עומר (זית / תקשורת)
  ('55555555-5555-5555-5555-55555555550b', '44444444-4444-4444-4444-444444444403', '11111111-1111-1111-1111-111111111108',
   'עומר ישתתף ביום הסיור של מגמת התקשורת ביום שני.', now() - interval '2 days', false, null, null, false, null, null),
  -- תהל (דקל / ביוטכנולוגיה)
  ('55555555-5555-5555-5555-55555555550c', '44444444-4444-4444-4444-44444444440e', '11111111-1111-1111-1111-111111111109',
   'תהל קיבלה אישור מעבדה מיוחד לניסוי שלה. מעולה!', now() - interval '3 days', true,
   '11111111-1111-1111-1111-111111111109', now() - interval '3 days', false, null, null),
  -- יונתן (דקל / תקשורת, mentor=מיכל)
  ('55555555-5555-5555-5555-55555555550d', '44444444-4444-4444-4444-44444444440d', '11111111-1111-1111-1111-111111111102',
   'יונתן חזר אחרי היעדרות ממושכת — צריך ליווי צמוד בשבועיים הקרובים.', now() - interval '12 hours', false, null, null, false, null, null),
  -- נגה (רימון / ביוטכנולוגיה)
  ('55555555-5555-5555-5555-55555555550e', '44444444-4444-4444-4444-44444444440a', '11111111-1111-1111-1111-111111111107',
   'נגה והצוות שלה סיימו את תכנון הניסוי. ממתינים לאישור חומרים.', now() - interval '20 hours', false, null, null, false, null, null);

-- ---------------------------------------------------------- message_reads ---
insert into public.message_reads (staff_id, message_id, read_at) values
  ('11111111-1111-1111-1111-111111111104', '55555555-5555-5555-5555-555555555501', now() - interval '8 days'),
  ('11111111-1111-1111-1111-111111111104', '55555555-5555-5555-5555-555555555502', now() - interval '6 days'),
  ('11111111-1111-1111-1111-111111111103', '55555555-5555-5555-5555-555555555507', now() - interval '3 days'),
  ('11111111-1111-1111-1111-11111111110a', '55555555-5555-5555-5555-555555555501', now() - interval '7 days'),
  ('11111111-1111-1111-1111-111111111102', '55555555-5555-5555-5555-555555555501', now() - interval '9 days'),
  ('11111111-1111-1111-1111-111111111102', '55555555-5555-5555-5555-555555555503', now() - interval '2 days');

-- ------------------------------------------------------------ app_settings --
insert into public.app_settings (key, value) values
  ('include_student_name_in_push', 'false'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------ learning groups -----
-- Fictional learning groups + weekly slots (Asia/Jerusalem wall clock).
-- קבוצת צילום (יום א׳ 16:00–17:30 + יום ב׳ 16:00–17:30) and
-- קבוצת רובוטיקה (יום ב׳ 16:00–17:30) deliberately CONFLICT on Monday —
-- used by e2e/tests to verify conflict prevention. Touching-slot pair
-- (יום ד׳ 10:00–11:00 + יום ד׳ 11:00–12:00) proves boundaries are allowed.
delete from public.learning_groups
 where id between '66666666-6666-6666-6666-666666666601'
              and '66666666-6666-6666-6666-66666666660f';
delete from public.learning_group_registration_windows
 where id between '66666666-6666-6666-6666-666666666611'
              and '66666666-6666-6666-6666-66666666661f';

insert into public.learning_groups (id, name, description, is_active, created_by_staff_id) values
  ('66666666-6666-6666-6666-666666666601', 'קבוצת צילום',    'מפגשי צילום ותיעוד אירועי התיכון', true,  '11111111-1111-1111-1111-111111111101'),
  ('66666666-6666-6666-6666-666666666602', 'קבוצת רובוטיקה', 'חממת רובוטיקה ותכנות',            true,  '11111111-1111-1111-1111-111111111101'),
  ('66666666-6666-6666-6666-666666666603', 'קבוצת מוזיקה',   null,                              true,  '11111111-1111-1111-1111-111111111101'),
  ('66666666-6666-6666-6666-666666666604', 'קבוצת ניו-מדיה', 'לא פעילה בסמסטר זה',              false, '11111111-1111-1111-1111-111111111101');

insert into public.learning_group_weekly_slots (learning_group_id, weekday, start_time, end_time) values
  -- צילום: יום א׳ 16:00–17:30 ויום ב׳ 16:00–17:30 (multi-slot group)
  ('66666666-6666-6666-6666-666666666601', 0, '16:00', '17:30'),
  ('66666666-6666-6666-6666-666666666601', 1, '16:00', '17:30'),
  -- רובוטיקה: יום ב׳ 16:00–17:30 — conflicts with צילום's Monday slot
  ('66666666-6666-6666-6666-666666666602', 1, '16:00', '17:30'),
  -- מוזיקה: touching slots on יום ד׳ (10:00–11:00 + 11:00–12:00 are valid together)
  ('66666666-6666-6666-6666-666666666603', 3, '10:00', '11:00'),
  ('66666666-6666-6666-6666-666666666603', 3, '11:00', '12:00'),
  -- ניו-מדיה: יום ה׳ 18:00–19:00 (inactive group)
  ('66666666-6666-6666-6666-666666666604', 4, '18:00', '19:00');

insert into public.learning_group_staff_leaders (learning_group_id, staff_id) values
  ('66666666-6666-6666-6666-666666666601', '11111111-1111-1111-1111-111111111102'), -- מיכל מובילה צילום
  ('66666666-6666-6666-6666-666666666602', '11111111-1111-1111-1111-111111111103'), -- יואב מוביל רובוטיקה
  ('66666666-6666-6666-6666-666666666601', '11111111-1111-1111-1111-111111111109'); -- ליאת (הנהלה) מובילה גם צילום

insert into public.learning_group_student_leaders (learning_group_id, student_id) values
  ('66666666-6666-6666-6666-666666666601', '44444444-4444-4444-4444-444444444401'), -- נועם מוביל צילום
  ('66666666-6666-6666-6666-666666666603', '44444444-4444-4444-4444-444444444402'); -- טליה מובילה מוזיקה

-- manual memberships (provenance matters: registration resubmission must
-- never remove these)
insert into public.learning_group_memberships (learning_group_id, student_id, source, added_by_staff_id) values
  ('66666666-6666-6666-6666-666666666601', '44444444-4444-4444-4444-444444444401', 'manual', '11111111-1111-1111-1111-111111111102'), -- נועם → צילום
  ('66666666-6666-6666-6666-666666666602', '44444444-4444-4444-4444-444444444405', 'manual', '11111111-1111-1111-1111-111111111103'); -- ליאו → רובוטיקה

-- a manual membership that ENDED (history is preserved, not destroyed)
insert into public.learning_group_memberships (learning_group_id, student_id, source, added_by_staff_id, joined_at, ended_at) values
  ('66666666-6666-6666-6666-666666666603', '44444444-4444-4444-4444-444444444403', 'manual', '11111111-1111-1111-1111-111111111101', now() - interval '60 days', now() - interval '10 days'); -- עומר סיים מוזיקה

-- public registration window (dev token: 'dev-lg-token' — hash only, no
-- encrypted copy, so the Copy-Link button is hidden for this seeded window)
insert into public.learning_group_registration_windows
  (id, title, token_hash, opens_at, closes_at, created_by_staff_id)
values
  ('66666666-6666-6666-6666-666666666611',
   'הרשמה לקבוצות למידה — סמסטר א׳',
   encode(sha256(convert_to('dev-lg-token', 'UTF8')), 'hex'),
   now() - interval '1 day',
   now() + interval '30 days',
   '11111111-1111-1111-1111-111111111101');

insert into public.learning_group_registration_window_groups (registration_window_id, learning_group_id) values
  ('66666666-6666-6666-6666-666666666611', '66666666-6666-6666-6666-666666666601'),
  ('66666666-6666-6666-6666-666666666611', '66666666-6666-6666-6666-666666666602'),
  ('66666666-6666-6666-6666-666666666611', '66666666-6666-6666-6666-666666666603');

-- ------------------------------------------------------- calendar events ----
-- Fictional events for the annual calendar / daily schedule / conflict tests.
-- Dates are relative (current_date) so dev data always lands around "today".
delete from public.calendar_events
 where id between '77777777-7777-7777-7777-777777777701'
              and '77777777-7777-7777-7777-77777777770f';

insert into public.calendar_events
  (id, title, description, start_date, start_time, end_date, end_time, is_all_day, recurrence, recurrence_until, status, created_by_staff_id)
values
  -- one-off, timed, everyone
  ('77777777-7777-7777-7777-777777777701', 'יום ספורט', 'תחרויות בין הקבוצות', current_date, '09:00', current_date, '13:00', false, 'none', null, 'active', '11111111-1111-1111-1111-111111111101'),
  -- all-day tomorrow
  ('77777777-7777-7777-7777-777777777702', 'יום צילומים', null, current_date + 1, '00:00', current_date + 1, '23:59', true, 'none', null, 'active', '11111111-1111-1111-1111-111111111101'),
  -- multi-day: Monday-ish span relative to today (+7 → +9)
  ('77777777-7777-7777-7777-777777777703', 'סדנה דו-יומית', 'סדנה בת שני ימים', current_date + 7, '09:00', current_date + 8, '15:00', false, 'none', null, 'active', '11111111-1111-1111-1111-111111111101'),
  -- weekly recurring — audience: learning group צילום (Monday slot mirrors the LG slot → conflict scenario)
  ('77777777-7777-7777-7777-777777777704', 'מפגש צילום מורחב', null, current_date + 7, '16:30', current_date + 7, '17:00', false, 'weekly', current_date + 197, 'active', '11111111-1111-1111-1111-111111111101'),
  -- weekly recurring — staff only
  ('77777777-7777-7777-7777-777777777705', 'ישיבת צוות שבועית', null, current_date + 7, '10:00', current_date + 7, '11:30', false, 'weekly', current_date + 197, 'active', '11111111-1111-1111-1111-111111111101'),
  -- monthly recurring on the 1st, everyone
  ('77777777-7777-7777-7777-777777777706', 'טקס ראש חודש', null, (date_trunc('month', current_date) + interval '1 month')::date, '08:30', (date_trunc('month', current_date) + interval '1 month')::date, '09:30', false, 'monthly', ((date_trunc('month', current_date) + interval '8 months')::date), 'active', '11111111-1111-1111-1111-111111111101'),
  -- one-off for a home group (זית)
  ('77777777-7777-7777-7777-777777777707', 'יום גיבוש זית', null, current_date + 3, '12:00', current_date + 3, '14:00', false, 'none', null, 'active', '11111111-1111-1111-1111-111111111101'),
  -- one-off for a major (תקשורת)
  ('77777777-7777-7777-7777-777777777708', 'סיור מגמת תקשורת', null, current_date + 4, '09:00', current_date + 4, '11:00', false, 'none', null, 'active', '11111111-1111-1111-1111-111111111101'),
  -- one-off for a specific staff member (מיכל)
  ('77777777-7777-7777-7777-777777777709', 'שיחה אישית מיכל', null, current_date + 2, '13:00', current_date + 2, '14:00', false, 'none', null, 'active', '11111111-1111-1111-1111-111111111101'),
  -- cancelled event (must not appear anywhere)
  ('77777777-7777-7777-7777-77777777770a', 'אירוע מבוטל', null, current_date + 5, '10:00', current_date + 5, '11:00', false, 'none', null, 'cancelled', '11111111-1111-1111-1111-111111111101');

insert into public.calendar_event_audiences (event_id, audience_type, greenhouse_group_id, major_id, learning_group_id, staff_id) values
  ('77777777-7777-7777-7777-777777777701', 'everyone', null, null, null, null),
  ('77777777-7777-7777-7777-777777777702', 'everyone', null, null, null, null),
  ('77777777-7777-7777-7777-777777777703', 'everyone', null, null, null, null),
  ('77777777-7777-7777-7777-777777777704', 'learning_group', null, null, '66666666-6666-6666-6666-666666666601', null),
  ('77777777-7777-7777-7777-777777777705', 'staff_only', null, null, null, null),
  ('77777777-7777-7777-7777-777777777706', 'everyone', null, null, null, null),
  ('77777777-7777-7777-7777-777777777707', 'home_group', '22222222-2222-2222-2222-222222222201', null, null, null),
  ('77777777-7777-7777-7777-777777777708', 'major', null, '33333333-3333-3333-3333-333333333301', null, null),
  ('77777777-7777-7777-7777-777777777709', 'staff_member', null, null, null, '11111111-1111-1111-1111-111111111102'),
  ('77777777-7777-7777-7777-77777777770a', 'everyone', null, null, null, null);

-- weekly mentor meeting for נועם with מיכל (Mentor), so the daily schedule and
-- conflict tests have a real meeting source (Mondays 16:00)
insert into public.meeting_schedules (id, student_id, staff_id, context, weekday, meeting_time)
values ('77777777-7777-7777-7777-777777777711', '44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111102', 'mentor', 1, '16:00')
on conflict do nothing;

-- generate occurrences for the current + next school weeks
insert into public.meeting_occurrences (schedule_id, due_at, week_start)
select '77777777-7777-7777-7777-777777777711',
       ((week_start::date + 1) + '16:00'::time) at time zone 'Asia/Jerusalem',
       week_start::date
  from generate_series(
         (current_date - ((extract(dow from current_date))::int))::timestamp,
         (current_date + 28)::timestamp,
         interval '7 days'
       ) as week_start
on conflict do nothing;

-- ------------------------------------------------- student employment -------
-- Canonical school years (1=א 2=ב 3=ג 4=ד): 401–404 = ג, 405–408 = ב,
-- 409–40c = ד, 40d+ = א (not employment-eligible).
update public.students set school_year = 3
 where id between '44444444-4444-4444-4444-444444444401' and '44444444-4444-4444-4444-444444444404';
update public.students set school_year = 2
 where id between '44444444-4444-4444-4444-444444444405' and '44444444-4444-4444-4444-444444444408';
update public.students set school_year = 4
 where id between '44444444-4444-4444-4444-444444444409' and '44444444-4444-4444-4444-44444444440c';
update public.students set school_year = 1
 where id between '44444444-4444-4444-4444-44444444440d' and '44444444-4444-4444-4444-4444444444ff';
-- תהל מוסקל demonstrates the real pre-deploy state: an existing student whose
-- year was never set (school_year NULL) — surfaced as "שנה לא הוגדרה" in the
-- employment screen until leadership/super_admin set it explicitly.
update public.students set school_year = null
 where id = '44444444-4444-4444-4444-44444444440e';

-- a real employment coordinator (רכז/ת תעסוקה): איתי גפן
insert into public.user_roles (staff_id, role)
values ('11111111-1111-1111-1111-111111111105', 'employment_coordinator')
on conflict do nothing;

-- placements / weekly slots / work logs (fictional)
delete from public.student_employment_placements
 where id between '88888888-8888-8888-8888-888888888801'
              and '88888888-8888-8888-8888-8888888888ff';

-- נועם (ג): historical placement + active placement Tue 08:30–15:00 + logs
insert into public.student_employment_placements
  (id, student_id, workplace_name, start_date, end_date, is_active, created_by_staff_id)
values
  ('88888888-8888-8888-8888-888888888801', '44444444-4444-4444-4444-444444444401',
   'משתלת החממה', current_date - 300, current_date - 90, false,
   '11111111-1111-1111-1111-111111111105'),
  ('88888888-8888-8888-8888-888888888802', '44444444-4444-4444-4444-444444444401',
   'בית קפה החממה', current_date - 60, null, true,
   '11111111-1111-1111-1111-111111111105');

insert into public.student_employment_weekly_slots (placement_id, weekday, start_time, end_time)
values
  ('88888888-8888-8888-8888-888888888802', 2, '08:30', '15:00');

insert into public.student_employment_work_logs
  (placement_id, student_id, work_date, start_time, end_time, duration_minutes, entered_by_staff_id)
values
  ('88888888-8888-8888-8888-888888888802', '44444444-4444-4444-4444-444444444401',
   current_date - 14, '08:30', '15:00', 390, '11111111-1111-1111-1111-111111111105'),
  ('88888888-8888-8888-8888-888888888802', '44444444-4444-4444-4444-444444444401',
   current_date - 7, '09:00', '14:00', 300, '11111111-1111-1111-1111-111111111105');

-- תמר (ב): active placement, logs summing to EXACTLY 200h (16×12h + 8h)
insert into public.student_employment_placements
  (id, student_id, workplace_name, start_date, is_active, created_by_staff_id)
values
  ('88888888-8888-8888-8888-888888888803', '44444444-4444-4444-4444-444444444405',
   'משתלת חממה דרום', current_date - 120, true,
   '11111111-1111-1111-1111-111111111105');

insert into public.student_employment_weekly_slots (placement_id, weekday, start_time, end_time)
values
  ('88888888-8888-8888-8888-888888888803', 0, '09:00', '14:00');

insert into public.student_employment_work_logs
  (placement_id, student_id, work_date, start_time, end_time, duration_minutes, entered_by_staff_id)
select '88888888-8888-8888-8888-888888888803', '44444444-4444-4444-4444-444444444405',
       (current_date - 1 - (g.k * 2))::date, '09:00', '21:00', 720,
       '11111111-1111-1111-1111-111111111105'
  from generate_series(0, 15) as g(k);
insert into public.student_employment_work_logs
  (placement_id, student_id, work_date, start_time, end_time, duration_minutes, entered_by_staff_id)
values
  ('88888888-8888-8888-8888-888888888803', '44444444-4444-4444-4444-444444444405',
   current_date - 1 - 32, '09:00', '17:00', 480, '11111111-1111-1111-1111-111111111105');

-- גילי (ד): active placement, logs ABOVE 200h (17×12h = 204h)
insert into public.student_employment_placements
  (id, student_id, workplace_name, start_date, is_active, created_by_staff_id)
values
  ('88888888-8888-8888-8888-888888888804', '44444444-4444-4444-4444-444444444409',
   'מוסך לוי', current_date - 150, true,
   '11111111-1111-1111-1111-111111111105');

insert into public.student_employment_weekly_slots (placement_id, weekday, start_time, end_time)
values
  ('88888888-8888-8888-8888-888888888804', 4, '08:00', '16:00');

insert into public.student_employment_work_logs
  (placement_id, student_id, work_date, start_time, end_time, duration_minutes, entered_by_staff_id)
select '88888888-8888-8888-8888-888888888804', '44444444-4444-4444-4444-444444444409',
       (current_date - 1 - (g.k * 2))::date, '08:00', '20:00', 720,
       '11111111-1111-1111-1111-111111111105'
  from generate_series(0, 16) as g(k);

-- audit the seeded placements (consistent with the RPC behavior)
insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
select '11111111-1111-1111-1111-111111111105', 'employment_placement_created',
       'employment_placement', pl.id,
       jsonb_build_object('student_id', pl.student_id, 'workplace', pl.workplace_name)
  from public.student_employment_placements pl
 where pl.id in ('88888888-8888-8888-8888-888888888801',
                 '88888888-8888-8888-8888-888888888802',
                 '88888888-8888-8888-8888-888888888803',
                 '88888888-8888-8888-8888-888888888804');

-- ------------------------------------------------------------ audit -------
insert into public.audit_logs (actor_staff_id, action, entity_type, entity_id, metadata)
values
  (null, 'seed_applied', 'system', null,
   jsonb_build_object('note', 'fictional seed data applied'));

commit;
