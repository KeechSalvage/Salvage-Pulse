// Hand-written mirrors of backend/models/schemas.py — keep in sync.
export type YardRole = "owner" | "sales_manager" | "inventory_manager" | "rep";
export type StaffRole = "master" | "admin";
export type Role =
  | "owner"
  | "sales_manager"
  | "inventory_manager"
  | "rep"
  | "manager"
  | "sales_rep"
  | "master"
  | "admin";

export const YARD_ROLES: { value: YardRole; label: string; description: string }[] = [
  { value: "owner", label: "Owner", description: "Full yard administration, billing, and team management" },
  { value: "sales_manager", label: "Sales Manager", description: "Oversees reps, coaching, calls, and performance" },
  { value: "inventory_manager", label: "Inventory Manager", description: "Manages incoming vehicles, parts stock, and lot tagging" },
  { value: "rep", label: "Sales Representative", description: "Handles customer calls, quotes, callbacks, and sales" },
];

export function roleLabel(role?: string): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "sales_manager":
      return "Sales Manager";
    case "inventory_manager":
      return "Inventory Manager";
    case "rep":
    case "sales_rep":
      return "Sales Representative";
    case "master":
      return "Master";
    case "admin":
      return "Admin";
    case "manager":
      return "General Manager";
    default:
      return role || "Sales Representative";
  }
}

export function isManagerLike(role?: string): boolean {
  return role === "owner" || role === "sales_manager" || role === "inventory_manager" || role === "manager";
}

export function isOwner(role?: string): boolean {
  return role === "owner";
}

export function isSalesManager(role?: string): boolean {
  return role === "sales_manager" || role === "owner" || role === "manager";
}

export function isInventoryManager(role?: string): boolean {
  return role === "inventory_manager" || role === "owner" || role === "manager";
}

export function isRep(role?: string): boolean {
  return role === "rep" || role === "sales_rep";
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  title: string;
  avatar_url: string;
  org_id: string;
  impersonated_by: string;
  disabled: boolean; // login turned off
  site_id: string; // yard location ("" = not assigned)
  must_change_password: boolean; // new staff login: must pick their own password first
}

export interface Site {
  id: string;
  name: string;
  reps: number;
  manager_id: string; // location manager: gets the daily email for just this lot, and only manages this lot
  manager_name: string;
  goal: number; // monthly sales goal ($), 0 = none
  month_revenue: number; // sales so far this month
}

export interface SiteGoalUpdate {
  goal: number;
}

export interface SiteManagerUpdate {
  manager_id: string;
}

export interface SiteBoardRow {
  site_id: string; // "" = reps with no location
  name: string;
  reps: number;
  calls: number;
  sales_calls: number;
  won: number;
  close_rate: number;
  revenue: number;
  goal: number;
  month_revenue: number; // this month so far (goal progress)
}

export interface SiteBoard {
  days: number;
  rows: SiteBoardRow[];
  month: string;
}

export interface ExtraSitesUpdate {
  extra_sites: number;
}

export interface ExtraSitesResult {
  extra_sites: number;
  max_sites: number;
  monthly_cost: number;
}

export interface SiteCreate {
  name: string;
}

export interface SiteList {
  sites: Site[];
  limit: number; // locations the plan allows
  plan_name: string;
  my_site_id: string; // set when the viewer is a location manager
}

export interface RepSiteUpdate {
  site_id: string;
}

export interface RepLoginUpdate {
  disabled: boolean;
  move_to_rep_id: string; // (turning off) hand their open callbacks + lists to this rep
}

export interface RepOpenWork {
  callbacks: number;
  lists: number;
}

export interface RepLoginEvent {
  id: string;
  rep_id: string;
  rep_name: string;
  action: "off" | "on";
  by: string;
  source: "reps_page" | "platform";
  moved: number;
  moved_to: string;
  at: string;
}

export interface RepLoginResult {
  user: User;
  moved: number;
}

export interface RepCreate {
  name: string;
  email: string;
  password: string;
  title: string;
  role?: Role;
}

export interface Turn {
  speaker: string;
  text: string;
}

export interface KeywordHit {
  keyword: string;
  count: number;
}

export type CallStatus = "processing" | "analyzed" | "completed" | "failed" | "imported";
export type Outcome = "won" | "lost" | "pending" | "n/a";

export interface CallSummary {
  id: string;
  rep_id: string;
  rep_name: string;
  customer_name: string;
  source: "audio" | "transcript" | "ringcentral";
  status: CallStatus;
  category: string;
  summary: string;
  vehicle: string;
  part_requested: string;
  outcome: Outcome;
  sentiment: string;
  overall_score: number;
  created_at: string;
  direction: string;
  duration_sec: number;
  source_category: string;
  topics: string[];
  order_value: number;
  quoted_value: number;
  parts_sold: string[]; // part types tagged as sold on this call
  delivery_call: boolean; // tagged as a delivery call (sold on a different call) — never counted as a sale
  delivery_kind: "" | "question" | "confirmation"; // inbound = delivery question, outbound = delivery confirmation
  delivery_check: DeliveryCheck | null;
  delivery_score: number | null; // 0-100 from the delivery checklist
  lost_reason: string;
  callback_done: boolean;
  callback_by: string;
  callback_at: string | null;
  vehicle_year: number | null;
  vehicle_make: string;
  vehicle_model: string;
}

export interface Call extends CallSummary {
  transcript: string;
  turns: Turn[];
  metrics: Record<string, number>;
  insights: string[];
  strengths: string[];
  improvements: string[];
  coaching_feedback: string;
  keyword_hits: KeywordHit[];
  has_audio: boolean;
  error: string;
  trackers: string[];
  customer_phone: string;
  external_url: string;
}

export interface TranscriptCreate {
  customer_name: string;
  transcript: string;
  rep_id?: string | null;
}

export interface Keyword {
  id: string;
  keyword: string;
  group: string;
}

export interface CategoryStat {
  category: string;
  count: number;
  avg_score: number;
}
export interface MetricStat {
  key: string;
  name: string;
  avg: number;
}
export interface TrendPoint {
  date: string;
  avg_score: number;
  calls: number;
}
export interface KeywordMonth {
  month: string; // YYYY-MM
  calls: number;
}
export interface KeywordStat {
  keyword: string;
  group: string;
  count: number;
  calls: number;
  monthly: KeywordMonth[]; // last 6 months, oldest first
}
export interface KeywordSuggestion {
  phrase: string;
  calls: number;
}
export interface LeaderRow {
  rep_id: string;
  name: string;
  title: string;
  calls: number;
  avg_score: number;
  conversion_rate: number;
  warranty_pitch_rate: number;
}
export interface CoachingFlag {
  call_id: string;
  rep_name: string;
  customer_name: string;
  category: string;
  overall_score: number;
  top_improvement: string;
}

export interface Overview {
  lot_name: string;
  rep: User | null;
  total_calls: number;
  avg_score: number;
  conversion_rate: number;
  won: number;
  lost: number;
  pending: number;
  category_breakdown: CategoryStat[];
  metric_averages: MetricStat[];
  trend: TrendPoint[];
  keyword_stats: KeywordStat[];
  leaderboard: LeaderRow[];
  coaching_flags: CoachingFlag[];
  focus_areas: string[];
  roleplay_sessions: number;
  scored_calls: number;
  warranty_pitch_rate: number;
  open_callbacks: number;
  inbound: number;
  outbound: number;
  voicemails: number;
  avg_duration_sec: number;
  hourly: HourStat[];
  topic_stats: TopicStat[];
}

export interface Scenario {
  id: string;
  title: string;
  difficulty: string;
  persona: string;
  objective: string;
  opening_hint: string;
  custom: boolean;
  price_objection: boolean;
  customer_brief: string; // only filled for managers
}
export interface ScenarioCreate {
  title: string;
  difficulty: "Easy" | "Medium" | "Hard";
  persona: string;
  objective: string;
  opening_hint: string;
  customer_brief: string;
  price_objection: boolean;
}
export interface ScenarioIdea {
  idea: string;
}

export interface RoleplayMessage {
  role: "customer" | "rep";
  text: string;
}

export interface RoleplayGrade {
  metrics: Record<string, number>;
  overall_score: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  coaching_feedback: string;
}

export interface RoleplaySession {
  id: string;
  user_id: string;
  user_name: string;
  scenario_id: string;
  scenario_title: string;
  messages: RoleplayMessage[];
  status: "active" | "graded";
  grade: RoleplayGrade | null;
  created_at: string;
}

export interface MetricDef {
  key: string;
  name: string;
  weight: number;
  description: string;
  ai_criteria?: string;
}

export interface ScoringSettings {
  custom_scoring: boolean;
  weights: Record<string, number>;
  defaults: Record<string, number>;
  metrics: MetricDef[];
}

export interface Meta {
  categories: string[];
  metrics: MetricDef[];
}

export interface ImportResult {
  file_from: string | null;
  file_to: string | null;
  total_rows: number;
  imported: number;
  updated: number;
  skipped: number;
  reps_created: string[];
  rep_logins: NewLogin[]; // one-time temporary passwords for staff created by this import
  demo_data_removed: boolean;
  vehicles: VehicleImportSummary | null; // vehicles/parts read from this file's topics
}

export interface MakeCount {
  make: string;
  calls: number;
}

export interface VehicleImportSummary {
  matched: number; // calls in this file that now have a vehicle
  newly_matched: number; // filled from topics by this upload
  with_part: number;
  top_makes: MakeCount[];
  untagged: number; // connected calls in this file still without a vehicle
}

export interface TagSuggestion {
  vehicle_year: number | null;
  vehicle_make: string;
  vehicle_model: string;
  from_call_at: string;
}

export interface TagItem {
  id: string;
  customer_name: string;
  customer_phone: string;
  rep_name: string;
  created_at: string;
  direction: string;
  duration_sec: number;
  topics: string[];
  summary: string;
  part_requested: string;
  suggestion: TagSuggestion | null;
  delivery_hint: string; // why this looks like a delivery call, "" if it doesn't
}

export interface TagLeader {
  user_id: string;
  name: string;
  tagged: number; // vehicles saved this week
  skipped: number; // calls marked "no vehicle" this week
}

export interface TaggingLeaderboard {
  week_start: string; // Monday 00:00 yard time
  leaders: TagLeader[];
  total_tagged: number;
}

export interface TagChampion {
  week_start: string;
  week_end: string;
  winners: TagLeader[]; // ties share; empty when nobody tagged
}

export interface PartPick {
  part: string;
  calls: number;
  model_calls: number; // calls about the chosen make/model asking for this part
}

export interface TagPartPicks {
  basis: "month" | "recent" | "default";
  month: string;
  model: string; // "Ford F-150" when that model's parts come first
  parts: PartPick[];
}

export interface TaggingQueue {
  total: number;
  items: TagItem[];
}

export interface TopicStat {
  topic: string;
  count: number;
}

export interface HourStat {
  hour: number;
  inbound: number;
  outbound: number;
}

export interface BulkAudioItem {
  filename: string;
  call_id: string;
  match: "interaction_id" | "phone_date" | "new" | "error";
  customer_name: string;
  rep_name: string;
  error: string;
}

export interface BulkAudioResult {
  items: BulkAudioItem[];
  matched: number;
  created: number;
  failed: number;
}

export interface CallbackItem extends CallSummary {
  customer_phone: string;
  reason: string;
  followed_up: boolean;
  followed_up_at: string | null;
  assigned_list_id: string; // set when a manager put this call on a named list
  assigned_list_name: string;
  assigned_by: string; // manager who added it ("" = automatic missed call)
  assigned_by_id?: string;
  assigned_by_role?: string;
  assigned_note: string;
  list_due_date: string;
  list_overdue: boolean;
}

export interface CallbackList {
  id: string;
  name: string;
  rep_id: string;
  rep_name: string;
  created_by: string;
  created_at: string;
  open: number;
  total: number;
  done: number; // marked called back
  sold: number; // list customers with a sale after they were added
  revenue: number;
  arrival_id: string; // made from a vehicle arrival's waiting callers
  due_date: string; // YYYY-MM-DD call-by date ("" = none)
  overdue: boolean;
}

export interface CallbackListUpdate {
  due_date: string | null; // null clears it
}

export interface ListLeader {
  rep_id: string;
  name: string;
  revenue: number;
  customers: number;
  lists: number;
}

export interface ListLeaderboard {
  month: string;
  reps: ListLeader[];
}

export type ChampionCategory = "winback_dollars" | "winback_customers" | "vehicle_sales" | "callback_lists" | "tagging" | "delivery_score" | "team_player" | "top_location";

export interface Champion {
  category: ChampionCategory;
  period: string; // YYYY-MM, or the week's Monday YYYY-MM-DD (tagging)
  names: string[];
  rep_ids: string[];
  detail: string;
  site_ids: string[]; // top_location: the winning lot(s)
}

export interface TrophyCount {
  name: string;
  trophies: number;
}

export interface ChampionCase {
  champions: Champion[];
  totals: TrophyCount[];
}

export interface ArrivalListCreate {
  rep_id?: string;
  rep_ids?: string[];
  due_date: string | null;
  name: string; // blank → "2017 Ford F-150 callers"
}

export interface CallbackListCreate {
  name: string;
  rep_id: string;
  due_date: string | null;
}

export interface CallbackAssign {
  call_ids: string[];
  rep_id: string;
  list_id: string;
  note: string;
}

export interface CallbackAssignResult {
  assigned: number;
}

export interface CallbackUpdate {
  done: boolean;
  sold_price?: number | null; // set → the callback sold parts (call becomes a won order)
  parts_sold?: string[];
}

export interface CustomerCalls {
  key: string;
  calls: CallSummary[]; // newest first, this call included
}

export interface DeliveryUpdate {
  delivery: boolean;
}

export interface DeliveryCheck {
  date_given: boolean;
  address_confirmed: boolean;
  thanked: boolean;
  notes: string; // AI coaching line
  source: "ai" | "manual";
  by: string;
}

export interface DeliveryCheckUpdate {
  date_given: boolean;
  address_confirmed: boolean;
  thanked: boolean;
}

export interface OverdueAlertResult {
  lists: number;
  emails: number;
  texts: number; // SMS nudges to reps with a mobile on file
}

export interface MobileNumber {
  mobile: string; // "" clears it
  days_off: number[]; // 0=Mon … 6=Sun — never text on these days
  vacation_start: string | null; // YYYY-MM-DD, both or neither
  vacation_end: string | null;
  shift_start: string; // "HH:MM" quiet hours: texts outside the shift wait for it to start ("" = any time)
  shift_end: string;
  held: number; // texts waiting for the shift to start (read-only)
}

export interface DeliveryLeader {
  rep_id: string;
  name: string;
  avg_score: number;
  checked: number;
}

export interface DeliveryLeaderboard {
  month: string;
  reps: DeliveryLeader[];
}

export interface TimeOffCreate {
  rep_id: string;
  start: string; // YYYY-MM-DD
  end: string;
  cover_rep_id: string; // gets their open callbacks when the time off starts
  note: string;
}

export interface TimeOff {
  id: string;
  rep_id: string;
  rep_name: string;
  start: string;
  end: string;
  cover_rep_id: string;
  cover_rep_name: string;
  note: string;
  created_by: string;
  handed_off: boolean;
  moved: number;
  gap_days: string[]; // (on create) days this makes the yard short-staffed
}

export interface TeamPlayer {
  rep_id: string;
  name: string;
  handled: number; // covered callbacks finished this month
  all_time: number; // "team player" badges
}

export interface TeamPlayerBoard {
  month: string;
  reps: TeamPlayer[];
}

export interface CoverageSettings {
  max_away: number; // warn when this many reps are away the same day
  warn_days_ahead: number; // email managers this many days before
}

export interface CoverageGap {
  day: string;
  away: string[];
}

export interface DeliveryTips {
  date_given: string; // "" = Salvage Pulse default tip
  address_confirmed: string;
  thanked: string;
}

export interface AwayRep {
  rep_id: string;
  until: string; // last away day
}

export interface PosterSendResult {
  month: string;
  sent: number;
  champions: number;
  lot_sent: number; // lot champion posters emailed to location managers
  lots: number;
}

export interface DeliveryStep {
  key: string;
  label: string;
  done: number;
  pct: number;
}

export interface DeliveryStats {
  calls: number;
  checked: number;
  avg_score: number | null;
  steps: DeliveryStep[];
  weakest: string; // step key skipped most ("" = none)
}

export interface SaleUpdate {
  sold: boolean;
  sold_price: number | null;
  parts_sold: string[];
}

export interface TeamBenchmark {
  avg_score: number;
  conversion_rate: number;
  warranty_pitch_rate: number;
  metric_averages: MetricStat[];
}

export interface CustomerStat {
  key: string;
  name: string;
  phone: string;
  calls: number;
  orders: number;
  talk_sec: number;
  last_call_at: string;
  last_call_id: string;
  last_category: string;
  top_topics: string[];
  rep_names: string[];
  tag: string;
  tag_source: "manual" | "auto" | "";
  est_value: number;
  value_basis: "ai" | "mixed" | "estimated" | "";
}

export type CustomerTag = "body_shop" | "mechanic" | "fleet" | "retail";

export interface CustomerTagUpdate {
  tag: CustomerTag | null;
}

export interface TypeStat {
  tag: string;
  customers: number;
  calls: number;
  orders: number;
  est_value: number;
}

export interface SuggestedContact extends CustomerStat {
  reason: string;
  priority: "high" | "medium" | "low";
  opener: string;
  last_mark: string;
}

export interface MonthPoint {
  month: string;
  calls: number;
  sales_calls: number;
  won: number;
  close_rate: number;
  est_value: number;
}

export interface MonthlyTrends {
  months: MonthPoint[];
  avg_order_value: number;
}

export interface RepMonthSeries {
  rep_id: string;
  rep_name: string;
  points: MonthPoint[];
  close_rate: number;
  change: number | null;
}

export interface RepMonthly {
  months: string[];
  reps: RepMonthSeries[];
}

export interface PartSeason {
  part: string;
  sold: number;
  asked: number;
  sold_by_month: number[];
  asked_by_month: number[];
  peak_month: string;
  sales_calls: number;
  close_rate: number;
  low_close: boolean;
  reasons: ReasonCount[];
}

export interface ReasonCount {
  reason: string;
  calls: number;
  from_ai: number;
}

export interface PartsSeasonal {
  months: string[];
  parts: PartSeason[];
  yard_close_rate: number;
}

export interface WinBackLeader {
  rep_id: string;
  rep_name: string;
  marks: number;
  customers_won: number;
  won_value: number;
}

export interface WinBackLeaderboard {
  months: string[];
  month: string;
  leaders: WinBackLeader[];
}

export interface WinBackWinners {
  month: string;
  top_dollars: WinBackLeader | null;
  top_customers: WinBackLeader | null;
  truck: TruckChamp[]; // vehicle-sales champion(s) that month (ties share)
}

export interface TruckChamp {
  rep_id: string;
  rep_name: string;
  sales: number;
}

export interface RepTrophies {
  rep_id: string;
  rep_name: string;
  trophies: number; // win-back trophies
  months_won: number;
  current_streak: number; // win-back streak
  best_streak: number;
  truck_trophies: number; // months as vehicle-sales champion
  truck_streak: number;
  best_truck_streak: number;
}

export interface TrophyWall {
  months: WinBackWinners[];
  reps: RepTrophies[];
}

export type WinBackResult = "reached" | "ordered" | "no_interest";

export interface WinBackMark {
  outcome: WinBackResult;
}

export interface WinBackOutcome {
  id: string;
  customer_key: string;
  customer_name: string;
  outcome: WinBackResult;
  rep_id: string;
  rep_name: string;
  created_at: string;
  confirmed: boolean;
  confirmed_call_id: string;
  confirmed_value: number;
}

export interface WinBackMonth {
  month: string;
  reached: number;
  ordered: number;
  no_interest: number;
  confirmed: number;
  confirmed_value: number;
}

export interface WinBackResults {
  months: WinBackMonth[];
  recent: WinBackOutcome[];
  total: number;
  confirmed: number;
}

export interface CustomerInsights {
  total_customers: number;
  repeat_customers: number;
  avg_order_value: number;
  avg_order_basis: "ai" | "manager" | "default";
  most_calls: CustomerStat[];
  most_orders: CustomerStat[];
  top_value: CustomerStat[];
  win_back: SuggestedContact[];
  suggested: SuggestedContact[];
  type_breakdown: TypeStat[];
  all_customers: CustomerStat[];
}

export interface CustomerNote {
  id: string;
  customer_key: string;
  text: string;
  author: string;
  created_at: string;
}

export interface CustomerNoteCreate {
  text: string;
}

export interface CustomerProfile {
  stat: CustomerStat;
  calls: CallSummary[];
  notes: CustomerNote[];
}

export interface DigestSettings {
  recipient_email: string;
  enabled: boolean;
}

export interface DigestResult {
  sent: boolean;
  recipient: string;
  reps: number;
  items: number;
  location_emails: number; // per-location copies sent to location managers
}

export interface BulkTagUpdate {
  keys: string[];
  tag: CustomerTag | null;
}

export interface BulkTagResult {
  updated: number;
}

export interface BusinessSettings {
  avg_order_value?: number | null;
  yard_name?: string | null;
}

export interface CallCoverage {
  total: number;
  ringcentral: number;
  earliest: string | null;
  latest: string | null;
}

export type PlanId = "starter" | "pro" | "pro_unlimited" | "enterprise" | "enterprise_platinum"; // pro_unlimited is sold as "Pro Platinum"
export type OrgStatus = "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "demo"; // incomplete = signed up, card not added yet

export interface Plan {
  id: PlanId;
  name: string;
  price: number; // per month, billed monthly
  price_yearly: number; // billed yearly (11 × monthly — one month free)
  max_reps: number | null;
  features: string[];
}

export type PremiumFeature =
  | "monthly_trends" | "rep_trends" | "parts_insights" | "trend_alerts" | "daily_email" | "inventory_insights"
  | "roleplay" | "leaderboards" | "vehicle_arrivals"; // Pro-and-up
export interface OrgInfo {
  id: string;
  name: string;
  plan: PlanId;
  status: OrgStatus;
  no_card_trial: boolean;
  email_verified: boolean;
  trial_ends_at: string | null;
  trial_ended?: boolean;
  days_left: number | null;
  access: boolean;
  past_due_days?: number;
  past_due_since?: string | null;
  reps: number;
  max_reps: number | null;
  card_on_file: boolean;
  trial_limited: boolean;
  limited_starts_at: string | null;
  locked_features: PremiumFeature[];
  roleplay_daily_cap: number;
  suggestion_cap: number;
  sample_data: boolean;
  blocked: boolean;
  plan_locked: PremiumFeature[]; // Enterprise-only features this plan doesn't include
  extra_rep_packs: number;
  max_extra_packs: number; // 0 = add-on not available on this plan
  extra_pack_price: number;
  preview_ends_at: string | null; // free Enterprise preview running until (Pro yards)
  preview_days_left: number | null;
  preview_available: boolean; // Pro yard that hasn't used its one free preview
  preview_ending: boolean; // ≤2 days of preview left → upgrade reminder
  show_enterprise_tour: boolean; // just upgraded; this manager hasn't closed the welcome tour
  billing_interval: BillingInterval;
  discount: YardDiscount | null; // Platform-console discount
  max_sites: number; // locations the plan allows
  extra_sites: number; // Enterprise Platinum paid locations beyond 4
  sites_used: number;
}

export interface GoogleSignupRequest {
  session_id?: string;
  access_token?: string;
  id_token?: string;
  yard_name: string;
  plan: PlanId;
}

export interface GoogleSignupResult {
  user: User;
  created: boolean;
}

export interface SignupRequest {
  yard_name: string;
  name: string;
  email: string;
  password: string;
  plan: PlanId;
}

export type BillingInterval = "month" | "year";

export interface CheckoutRequest {
  plan: PlanId;
  origin_url: string;
  start_now?: boolean;
  interval?: BillingInterval; // yearly = one month free
}

export interface CheckoutResponse {
  checkout_url: string;
  session_id: string;
}

export interface PaymentStatus {
  session_id: string;
  status: string;
  payment_status: string;
}

export interface AdminOrgUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  title: string;
  disabled: boolean;
}

export interface AdminOrg {
  id: string;
  name: string;
  plan: PlanId;
  status: OrgStatus;
  trial_ends_at: string | null;
  created_at: string;
  users: number;
  calls: number;
  ringcentral_connected: boolean;
  card_on_file: boolean;
  blocked: boolean;
  cancel_reason: string;
  discount: YardDiscount | null;
  sites: number;
  max_sites: number;
  extra_sites: number; // Enterprise Platinum add-on ($100/mo each)
  phone?: string;
  billing_contact_name?: string;
  billing_email?: string;
  billing_phone?: string;
  address?: string;
  user_list?: AdminOrgUser[];
}

export interface YardDiscount {
  percent: number;
  months: number; // monthly bills it covers
  ends_at: string | null; // null until it's on a subscription (applied at checkout)
  applied: boolean;
  price: number; // plan price per billing period, before the discount
  discounted_price: number;
  set_by: string;
  set_at: string | null;
  reason: string; // staff note, e.g. "loyalty"
}

export interface AdminDiscount {
  percent: number;
  months: number;
  reason: string;
}

export interface AdminOrgDiscount {
  org: AdminOrg;
  message: string;
  payment_link: string; // (discount link) Stripe checkout at the lower price
}

export interface DiscountMonth {
  month: string; // YYYY-MM
  cost: number;
  yards: number;
  projected: boolean;
}

export interface DiscountYardRow {
  org_id: string;
  org_name: string;
  percent: number;
  reason: string;
  monthly_cost: number;
  applied: boolean;
  ends_at: string | null;
}

export interface DiscountSummary {
  months: DiscountMonth[];
  yards: DiscountYardRow[];
  this_month: number;
}

export interface AdminOrgCreate {
  yard_name: string;
  manager_name: string;
  email: string;
  password: string;
  plan: PlanId;
  status: "trialing" | "active";
  discount: AdminDiscount | null; // baked into the payment link
}

export interface AdminOrgCreated {
  org: AdminOrg;
  payment_link: string;
}

export interface AdminOrgUpdate {
  name?: string;
  plan?: PlanId;
  status?: OrgStatus;
  trial_ends_at?: string;
  blocked?: boolean;
  extra_sites?: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  title: string;
  org_id: string;
  org_name: string;
  disabled: boolean;
}

export interface AdminUserCreate {
  org_id: string;
  name: string;
  email: string;
  role: Role;
  title?: string;
  password?: string;
}

export interface AdminUserUpdate {
  name?: string;
  email?: string;
  role?: Role;
  title?: string;
  password?: string;
  disabled?: boolean;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target: string;
}

export interface RingCentralStatus {
  configured: boolean;
  connected: boolean;
  connected_by: string;
  last_sync_at: string | null;
  last_result: string;
}

export interface ConnectorStatus {
  webhook_url: string;
  ringcentral: RingCentralStatus;
}

export interface SyncResult {
  imported: number;
  updated: number;
  skipped: number;
}

export interface AuthUrl {
  authorize_url: string;
}

export interface ScenarioScore {
  best: number;
  attempts: number;
  last_at: string;
}

export interface ScoreboardRow {
  rep_id: string;
  rep_name: string;
  scores: Record<string, ScenarioScore>;
}

export interface ScoreboardScenario {
  id: string;
  title: string;
  price_objection: boolean;
}

export interface RoleplayScoreboard {
  scenarios: ScoreboardScenario[];
  rows: ScoreboardRow[];
}

export interface KeywordCreate {
  keyword: string;
  group: string;
}
export interface OkResponse {
  ok: boolean;
}
export interface PhraseBody {
  phrase: string;
}
export interface RepTileUse {
  keyword_id: string;
  keyword: string;
  calls: number;
  pct: number;
}
export interface RepWordUse {
  rep_id: string;
  rep_name: string;
  total_calls: number;
  tiles: RepTileUse[];
}
export interface TrendAlert {
  phrase: string;
  keyword_id: string;
  this_month: number;
  projected: number;
  baseline: number;
  ratio: number;
}
export interface AdminCancel {
  reason: string;
  block: boolean;
}
export interface VehicleUpdate {
  vehicle_year: number | null;
  vehicle_make: string;
  vehicle_model: string;
  part_requested?: string;
}
export interface VehicleRow {
  make: string;
  model: string;
  calls: number;
  orders: number;
  close_rate: number;
  year_min: number | null;
  year_max: number | null;
  top_years: number[];
  top_parts: string[];
  last_call: string | null;
  calls_30d: number; // calls in the last 30 days
  lost: number; // sales calls that didn't buy
  body_type: string; // car | suv | van | pickup | other ("" on make rows)
}
export interface VehicleDemand {
  tracked_calls: number;
  total_calls: number;
  makes: VehicleRow[];
  models: VehicleRow[];
  body_counts: Record<string, number>; // tracked calls per body style (unfiltered)
}
export interface AssignmentCreate {
  scenario_id: string;
  rep_ids: string[];
  due_date: string; // YYYY-MM-DD
  pass_score: number;
}
export interface Assignment {
  id: string;
  scenario_id: string;
  scenario_title: string;
  rep_id: string;
  rep_name: string;
  due_date: string;
  pass_score: number;
  assigned_by: string;
  created_at: string;
  best_score: number | null;
  attempts: number;
  status: "done" | "open" | "overdue";
  completed_at: string | null;
}
export interface FunnelMonth {
  month: string;
  signups: number;
  cards_added: number;
  paid: number;
  canceled: number;
}
export interface FreeDayYard {
  org_id: string;
  name: string;
  started_at: string;
  outcome: "on_free_day" | "added_card" | "no_card";
  card_added_at: string | null;
}
export interface SignupAlert {
  network: string;
  yards: string[];
  org_ids: string[];
  count: number;
  last_at: string;
}
export interface ResendResult {
  sent: boolean;
}
export interface FreeDayStats {
  started: number;
  on_free_day: number;
  added_card: number;
  added_during_day: number;
  no_card: number;
  conversion_rate: number;
  started_30d: number;
  added_card_30d: number;
  median_hours_to_card: number | null;
  recent: FreeDayYard[];
  alerts: SignupAlert[];
}
export interface Funnel {
  months: FunnelMonth[];
  totals: FunnelMonth;
  trialing_now: number;
}
export interface ReminderRow {
  org_id: string;
  org_name: string;
  to: string;
  kind: "day4" | "day6";
  due_at: string;
  sent_at: string | null;
}
export interface TrialReminders {
  enabled: boolean;
  upcoming: ReminderRow[];
}
export interface RemindersToggle {
  enabled: boolean;
}
export interface ReminderPreview {
  subject: string;
  html: string;
}
export interface ExtendTrial {
  days: number;
}
export type BodyType = "car" | "suv" | "van" | "pickup" | "other";
export type VehicleRank = "calls" | "recent" | "lost"; // most asked | last 30 days | didn't buy

export interface VehicleModelOption {
  model: string;
  calls: number;
  calls_30d: number;
  lost: number;
}

export interface VehicleMake {
  make: string;
  calls: number;
  models: string[];
  calls_30d: number;
  lost: number;
  model_stats: VehicleModelOption[]; // same order as models
}
export interface VehicleOptions {
  makes: VehicleMake[];
  year_min: number | null;
  year_max: number | null;
}
export interface StockAlert {
  make: string;
  model: string;
  part: string;
  years: string;
  this_month: number;
  projected: number;
  baseline: number;
  ratio: number;
  lost: number; // didn't-buy calls this month
}
export interface WatchItemCreate {
  make: string;
  model: string;
  year_from: number | null;
  year_to: number | null;
  part: string;
}
export interface WatchItem extends WatchItemCreate {
  id: string;
  label: string;
  calls_7d: number;
  calls_30d: number;
  prev_30d: number;
  orders_30d: number;
  lost_30d: number; // didn't order (lost or still pending)
  top_parts: string[];
}
export interface WatchEmail {
  enabled: boolean;
  recipient_email: string;
  last_sent_at: string | null;
}
export interface WatchEmailUpdate {
  enabled: boolean;
  recipient_email: string;
}
export interface LostVehicle {
  make: string;
  model: string;
  part: string;
  asked: number;
  lost: number;
  won: number;
  close_rate: number;
  years: string;
  last_asked: string;
  calls_30d: number;
  body_type: string;
}
export interface SameVehicleCaller {
  call_id: string;
  customer_name: string;
  customer_phone: string;
  vehicle: string;
  part_requested: string;
  outcome: Outcome;
  rep_name: string;
  created_at: string;
  calls: number;
}
export type ArrivalStatus = "to_call" | "called" | "sold" | "not_interested";
export interface ArrivalCreate {
  vehicle_year: number;
  vehicle_make: string;
  vehicle_model: string;
  note: string;
  stock_number: string; // yard stock #
  year_span: number;
  cost: number | null; // what the yard paid for the vehicle
}
export interface ArrivalCostUpdate {
  cost: number | null; // null clears it
}
export interface ArrivalCaller {
  key: string;
  customer_name: string;
  customer_phone: string;
  vehicle: string;
  parts: string[];
  exact_year: boolean;
  last_asked: string;
  times_asked: number;
  rep_id: string;
  rep_name: string;
  last_call_id: string;
  status: ArrivalStatus;
  sold_price: number | null;
  parts_sold: string[];
  updated_by: string;
  texted_at: string | null; // practice mode: logged, not actually sent
  text: string;
  updated_at: string | null;
  replied_at: string | null; // first call from this caller after the text
  reply_call_id: string;
  ordered_at: string | null; // first later call that ended in an order
  sms_sid: string;
  sms_status: string; // queued / sent / delivered / failed / undelivered (live texts)
  sms_error: string;
  sms_reply: string;
  sms_replied_at: string | null;
}
export interface ArrivalResults {
  callers: number;
  contacted: number;
  texted: number;
  replied: number;
  sold: number;
  orders: number;
  first_sale_days: number | null;
  revenue: number; // sales it brought in (won orders from its callers after it was logged)
  revenue_estimated: boolean; // some orders used the yard average order value
  profit: number | null; // revenue - cost (null without a cost, and for reps)
}
export interface ArrivalBlast {
  at: string;
  by: string;
  template: string;
  count: number;
  mode: "practice" | "live";
  failed: number;
}
export interface StreakChase {
  show: boolean; // exactly one vehicle sale behind the vehicle-streak leader this month
  month: string;
  leader_name: string;
  leader_streak: number;
  leader_sales: number;
  my_sales: number;
}

export interface StreakBreak {
  kind: "" | "broken" | "breaking"; // broken = last month ended a 2+ month run; breaking = live this month
  month: string;
  leader_name: string;
  streak: number;
  breakers: string[];
  breaker_sales: number;
  leader_sales: number;
}

export interface EnterpriseUpgrade {
  upgraded: boolean; // subscription switched now
  checkout_url: string; // no card yet → Stripe Checkout
}

export interface NewLogin {
  name: string;
  email: string;
  temp_password: string;
}

export interface ForgotPasswordRequest {
  email: string;
}
export interface PasswordResetRequest {
  token: string;
  password: string;
}
export interface PasswordChange {
  current_password: string;
  new_password: string;
}

export interface StaffLockdown {
  enabled: boolean; // master/admin must sign in with Google (Salvage Pulse account)
  you_signed_in_with_google: boolean;
  staff_domain: string;
  google_linked: number; // active staff who have signed in with their staff-domain Google account
  staff_total: number; // turns on automatically once all are linked
}

export interface ResetResult {
  ok: boolean;
  message: string;
}

export interface GoogleAccountOption {
  id: string;
  name: string;
  email: string;
  role: string;
  title: string;
  avatar_url?: string;
}

export interface GoogleAuthConfig {
  configured: boolean;
  client_id: string;
  accounts?: GoogleAccountOption[];
}

export interface GoogleSessionRequest {
  session_id?: string;
  access_token?: string;
  id_token?: string;
  user_id?: string;
}

export interface DemoLoginRequest {
  role: "owner" | "sales_manager" | "inventory_manager" | "rep" | "manager" | "master" | "admin";
}

export interface DemoLoginStatus {
  enabled: boolean;
}

export interface SmsStatus {
  live: boolean;
  from_number: string;
  problem: string; // Twilio keys saved but not usable yet (why)
}
export interface TruckLeader {
  rep_id: string;
  rep_name: string;
  sales: number;
  avg_hours_to_sale: number | null;
  contacted: number;
}
export interface TruckWinner {
  month: string; // previous calendar month YYYY-MM
  winners: TruckLeader[]; // ties share the trophy; empty = no sales
}

export interface TruckLeaderboard {
  month: string;
  leaders: TruckLeader[];
}
export interface Arrival {
  id: string;
  vehicle_year: number;
  vehicle_make: string;
  vehicle_model: string;
  note: string;
  stock_number: string;
  year_span: number;
  cost: number | null; // what the yard paid (managers only; null for reps)
  callback_list_id: string; // set once its waiting callers became a callback list
  created_by: string;
  created_at: string;
  callers: ArrivalCaller[];
  blasts: ArrivalBlast[];
  results: ArrivalResults | null;
}
export interface ArrivalCallerUpdate {
  status: ArrivalStatus;
  sold_price?: number | null;
  parts_sold?: string[];
}
export interface TextBlast {
  template: string;
}
export interface QueueItem {
  kind: "arrival" | "missed" | "roleplay";
  id: string;
  title: string;
  detail: string;
  phone: string;
  urgent: boolean;
  link: string;
  at: string;
}
export interface QueueProgress {
  cleared_today: number;
  remaining: number;
  pct: number;
  behind: boolean;
}
export interface CallQueue {
  items: QueueItem[];
  counts: Record<string, number>;
  progress: QueueProgress | null;
}
export interface RepQueueRow {
  rep_id: string;
  rep_name: string;
  cleared_today: number;
  remaining: number;
  pct: number;
  behind: boolean;
}
export interface TeamQueue {
  after_noon: boolean;
  reps: RepQueueRow[];
}
export interface ExtraLogins {
  packs: number;
}

export type ThemeMode = "dark" | "light";

export interface Branding {
  yard_name: string;
  accent: string; // "#RRGGBB"; "" = Salvage Pulse amber
  default_mode: ThemeMode;
  logo_url: string; // "" = Salvage Pulse logo
  user_mode: "" | ThemeMode; // this user's own choice ("" = follow the yard)
  mode: ThemeMode; // effective
}

export interface BrandingUpdate {
  accent: string;
  default_mode: ThemeMode;
}

export interface ThemeModeUpdate {
  mode: "" | ThemeMode;
}

export interface CompareRow {
  group: string;
  label: string;
  values: Record<string, boolean | string>; // plan id → included / not / detail text
}

export interface PlanComparison {
  plans: Plan[];
  rows: CompareRow[];
}

export interface DrillCalls {
  total: number; // matching calls (list is capped at 200)
  calls: CallSummary[];
}

export type DrillOutcome = "won" | "lost" | "pending" | "sales";

/** Query for GET /api/drill/calls — every field optional, combined with AND. */
export interface DrillQuery {
  rep_id?: string;
  category?: string;
  date?: string; // YYYY-MM-DD
  month?: string; // YYYY-MM
  hour?: number;
  direction?: "inbound" | "outbound";
  topic?: string;
  metric?: string;
  outcome?: DrillOutcome;
  winback_month?: string;
  local_date?: string; // yard-time day (Reports page)
  from_day?: string; // yard-time range, inclusive (Reports page)
  to_day?: string;
  vehicle_make?: string;
  vehicle_model?: string;
  part?: string; // canonical part name (seasonal parts table)
  part_sold?: string; // part type tagged as sold
  price_missing?: boolean; // sales with no amount entered yet
}

export interface TileLayout {
  page: string;
  order: string[];
  source: "user" | "yard" | "default";
}

export interface TileLayoutSave {
  order: string[];
  target: string; // "yard" or a user id
}

export interface LayoutTarget {
  target: string;
  name: string;
  role: string;
  has_custom: boolean;
}

export interface StaffDevice {
  id: string;
  browser: string;
  ip: string;
  first_seen: string | null;
  last_seen: string | null;
  this_browser: boolean;
  nickname: string;
}

export interface StaffDevices {
  user_id: string;
  name: string;
  email: string;
  role: string;
  sessions: number;
  devices: StaffDevice[];
}

export interface SignOutResult {
  ended: number;
  you: boolean;
}

export interface BulkDelete {
  ids: string[];
}

export interface BulkDeleteResult {
  deleted: number;
}

export type ContactKind = "support" | "suggestion";

export interface ContactCreate {
  kind: ContactKind;
  subject: string;
  message: string;
  page: string; // app path they were on
}

export interface ContactMessage {
  id: string;
  kind: ContactKind;
  subject: string;
  message: string;
  user_name: string;
  user_email: string;
  role: string;
  org_id: string;
  org_name: string;
  page: string;
  status: "new" | "resolved";
  created_at: string;
  resolved_by: string;
  resolved_at: string | null;
  replies: ContactReply[];
  reply_unread: boolean;
}

export interface ContactReply {
  by: string;
  text: string;
  at: string;
}

export interface ContactReplyCreate {
  text: string;
  resolve: boolean;
}

export interface ContactResult {
  ok: boolean;
  id: string;
}

export interface ContactStatusUpdate {
  status: "new" | "resolved";
}

export interface ImportBatch {
  id: string;
  filename: string;
  by: string;
  created_at: string;
  rows: number;
  new_calls: number;
  remaining: number;
}

export interface RangeDelete {
  date_from: string;
  date_to: string;
  source: "" | "ringcentral" | "audio" | "transcript";
  dry_run: boolean;
}

export interface RangeDeleteResult {
  matched: number;
  deleted: number;
}

export interface ReportTotals {
  calls: number;
  inbound: number;
  outbound: number;
  voicemails: number;
  avg_score: number;
  avg_duration_sec: number;
  sales_calls: number;
  won: number;
  close_rate: number;
  revenue: number;
}

export interface ReportRep {
  rep_id: string;
  name: string;
  calls: number;
  avg_score: number;
  sales_calls: number;
  won: number;
  close_rate: number;
  revenue: number;
}

export interface ReportCount {
  label: string;
  calls: number;
  won: number;
  key: string; // drill key: canonical part, or "make|model"
}

export interface ReportDay {
  date: string;
  calls: number;
  won: number;
}

export interface ReportArrival {
  id: string;
  vehicle: string;
  logged: string;
  cost: number | null;
  revenue: number;
  profit: number; // revenue - cost (missing cost counts as $0)
  sold: number;
  orders: number;
}

export interface Report {
  date_from: string;
  date_to: string;
  totals: ReportTotals;
  by_rep: ReportRep[];
  by_category: ReportCount[];
  top_parts: ReportCount[];
  top_vehicles: ReportCount[];
  daily: ReportDay[];
  arrivals: ReportArrival[];
  avg_order_value: number;
  parts_sold: PartsSoldMonth[]; // part types actually sold, per month in the range
  price_missing: number; // won sales with no amount entered
}

export interface PartSold {
  part: string;
  sales: number;
  revenue: number; // sale price split evenly across the parts on that sale
}

export interface PartsSoldMonth {
  month: string; // YYYY-MM
  parts: PartSold[];
}

export interface ReportRecipient {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface MonthlyReportSettings {
  enabled: boolean;
  user_ids: string[] | null; // null = every manager and rep
  extra_emails: string[];
}

export interface MonthlyReportSettingsOut extends MonthlyReportSettings {
  people: ReportRecipient[];
}

export interface CallCleanupRecord {
  id: string;
  label: string;
  count: number;
  by: string;
  deleted_at: string;
  expires_at: string;
}

export interface RestoreResult {
  restored: number;
}

export interface MonthlyReportResult {
  sent: number;
  skipped: number;
  month: string;
}

export interface CoverRequestCreate {
  to_rep_id: string; // teammate asked to cover
  start: string; // YYYY-MM-DD
  end: string; // = start for a single day
  note: string;
}

export interface CoverBlock {
  reason: string;
}

export interface CoverRequest {
  id: string;
  from_rep_id: string;
  from_rep_name: string;
  to_rep_id: string;
  to_rep_name: string;
  start: string;
  end: string;
  note: string;
  // pending → teammate asked; accepted → waiting for a manager; approved → on the Shift calendar
  status: "pending" | "accepted" | "approved" | "declined" | "blocked" | "cancelled";
  approved_by: string;
  block_reason: string;
  time_off_id: string; // shift-calendar entry created on accept
  texted: boolean;
  created_at: string;
}

export interface RecentUpload {
  id: string;
  customer_name: string;
  rep_name: string;
  source: string; // transcript | audio
  status: string; // processing | analyzed | failed
  created_at: string;
  uploaded_by_name: string;
  category: string;
}

export interface DemoLoginSwitch {
  enabled: boolean; // one-tap demo login on the sign-in page
  changed_by: string;
  changed_at: string | null;
}

export interface NotMeRequest {
  token: string;
}

export interface NotMeResult {
  ok: boolean;
  message: string;
  browser: string;
  reset_token: string;
}

export interface ForgetDeviceResult {
  devices: StaffDevice[];
  you: boolean;
}

export interface DeviceNickname {
  nickname: string;
}

export interface LockAccountRequest {
  token: string;
}

export interface LockAccountResult {
  ok: boolean;
  message: string;
  reset_token: string;
}

export interface StaffAccount {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  must_change_password: boolean; // still on the starting password
  created_at: string | null;
  you: boolean;
  google_linked: boolean; // has signed in with their staff-domain Google account
  email_bounced_at: string | null; // last email bounced — alerts and set-password links can't reach them
  email_bounce_reason: string;
}

export interface StaffCreate {
  name: string;
  email: string;
  role: "master" | "admin";
}

export interface StaffCreated {
  account: StaffAccount;
  emailed: boolean; // set-password link emailed → nothing to share
  temp_password: string; // only when the email couldn't be sent; shown once
}

export interface StaffUpdate {
  name?: string;
  role?: "master" | "admin";
  disabled?: boolean;
}
