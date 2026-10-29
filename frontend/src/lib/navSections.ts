export interface PageSection {
  id: string; // DOM element ID or hash (e.g. "team-stats")
  label: string; // Human readable name in the dropdown
}

export interface NavItemConfig {
  to: string;
  label: string;
  id: string;
  icon: string;
  sections?: PageSection[];
}

/**
 * Registry of page sections for yard user navigation.
 * Only complex multi-section dashboards and views retain a quick-jump dropdown.
 */
export const YARD_PAGE_SECTIONS: Record<string, PageSection[]> = {
  // Team Dashboard (/dashboard)
  dashboard: [
    { id: "dashboard-stats", label: "Key Stat Tiles" },
    { id: "monthly-trends", label: "Monthly Trends" },
    { id: "rep-trends", label: "Rep Comparison" },
    { id: "seasonal-parts", label: "Seasonal Parts" },
    { id: "leaderboard", label: "Rep Rankings" },
    { id: "call-mix", label: "Call Categories" },
    { id: "customers", label: "Customers" },
    { id: "winback-results", label: "Win-back Results" },
    { id: "winback-leaderboard", label: "Win-back Leaderboard" },
    { id: "call-volume", label: "Calls by Hour" },
    { id: "topics", label: "Caller Topics" },
    { id: "score-trend", label: "QA Score Trend" },
    { id: "metrics", label: "Metric Averages" },
    { id: "coaching-flags", label: "Coaching Flags" },
  ],

  // My Performance (/me or /reps/:id)
  me: [
    { id: "performance-stats", label: "Performance Stats" },
    { id: "monthly-trends", label: "Monthly Trends" },
    { id: "customers", label: "Customers" },
    { id: "delivery-coaching", label: "Delivery Calls" },
    { id: "winback-results", label: "Win-back Results" },
    { id: "winback-leaderboard", label: "Win-back Leaderboard" },
    { id: "skills-radar", label: "7-Metric Radar" },
    { id: "focus", label: "Coaching Focus Areas" },
    { id: "call-mix", label: "Call Makeup" },
    { id: "score-trend", label: "Score Over Time" },
    { id: "recent-calls", label: "Recent Calls" },
  ],

  // Callbacks (/callbacks)
  callbacks: [
    { id: "callbacks-status-tabs", label: "Open vs. Resolved" },
    { id: "callbacks-sources-bar", label: "Lists & Sources" },
    { id: "callbacks-queue-table", label: "Callback Queue" },
  ],

  // Reps / Team (/team)
  team: [
    { id: "callback-lists", label: "Callback Lists" },
    { id: "delivery-tips", label: "Delivery Tip Texts" },
    { id: "sites", label: "Yard Locations" },
    { id: "reps", label: "Rep Cards" },
    { id: "login-log", label: "Login Activity Log" },
    { id: "rep-trends", label: "Rep Comparison" },
    { id: "tag-trophy", label: "Tagging Champion" },
    { id: "truck-trophy", label: "Vehicle-Sales Trophy" },
    { id: "trophy-wall", label: "Trophy Wall" },
    { id: "roleplay-scoreboard", label: "Role-play Scoreboard" },
    { id: "yard-name", label: "Yard Name" },
    { id: "order-value", label: "Average Order Value" },
    { id: "daily-email", label: "Daily Email Digest" },
  ],

  // Reports (/reports)
  reports: [
    { id: "report-summary-stats", label: "Overview Metrics" },
    { id: "daily", label: "Calls by Day" },
    { id: "reps", label: "Rep Results" },
    { id: "categories", label: "Call Categories" },
    { id: "parts", label: "Top Parts" },
    { id: "vehicles", label: "Top Vehicles" },
    { id: "parts-sold", label: "Parts Sold Ranking" },
    { id: "arrivals", label: "Vehicle Profit" },
  ],
};
