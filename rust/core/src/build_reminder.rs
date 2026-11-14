//! Watches live gold and fires one reminder per build-path step the moment the
//! player can afford it ("650g — buy Boots + Dark Seal").
//!
//! Data comes from the game's own Live Client Data API (see `live_client`), so
//! this needs nothing but League running — no Overwolf, no injection. Delivery
//! is left to the shell: this decides *when* and *what*, and hands out a
//! [`Reminder`].

use serde::Serialize;

use crate::{build_paths, champion_data, live_client::Snapshot};

/// Back-to-back steps (a plan with 650 and 700 thresholds, say) shouldn't stack
/// two popups in the same second.
pub const MIN_NOTIFY_GAP_MS: u64 = 6_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderItem {
    pub id: i64,
    pub name: String,
    pub cost: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub index: usize,
    pub gold: i64,
    pub current_gold: i64,
    pub total_steps: usize,
    pub champ_key: String,
    pub items: Vec<ReminderItem>,
}

impl Reminder {
    /// "Buy: Boots + Dark Seal"
    pub fn title(&self) -> String {
        format!(
            "Buy: {}",
            self.items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>().join(" + ")
        )
    }
    /// "650g reached — step 1/2"
    pub fn body(&self) -> String {
        format!("{}g reached — step {}/{}", self.gold, self.index + 1, self.total_steps)
    }
}

#[derive(Debug, Clone, Copy)]
struct StepState {
    armed: bool,
    skipped: bool,
}

/// Monotonic-ish clock, injectable so tests can jump past the notify gap
/// without sleeping.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

pub struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

pub struct BuildReminder {
    champ_key: Option<String>,
    gold: i64,
    owned: Vec<i64>,
    plan: Option<build_paths::ResolvedPlan>,
    steps: Vec<StepState>,
    last_notify_at: u64,
    clock: Box<dyn Clock>,
    /// Master switch, mirrored from config.
    pub enabled: bool,
}

impl Default for BuildReminder {
    fn default() -> Self {
        Self::new(Box::new(SystemClock))
    }
}

impl BuildReminder {
    pub fn new(clock: Box<dyn Clock>) -> Self {
        Self {
            champ_key: None,
            gold: 0,
            owned: Vec::new(),
            plan: None,
            steps: Vec::new(),
            last_notify_at: 0,
            clock,
            enabled: true,
        }
    }

    pub fn reset(&mut self) {
        self.champ_key = None;
        self.gold = 0;
        self.owned.clear();
        self.plan = None;
        self.steps.clear();
        self.last_notify_at = 0;
    }

    pub fn champion(&self) -> Option<&str> {
        self.champ_key.as_deref()
    }

    /// Dismisses a step for the rest of the match (the popup's ✕), so a plan the
    /// player has deliberately deviated from stops asking.
    pub fn skip_step(&mut self, index: usize) {
        if let Some(state) = self.steps.get_mut(index) {
            state.skipped = true;
        }
    }

    fn load_plan(&mut self) {
        let key = self.champ_key.clone().unwrap_or_default();
        self.plan = build_paths::resolve_for_champion(&key);
        self.steps = self
            .plan
            .as_ref()
            .map(|p| vec![StepState { armed: true, skipped: false }; p.steps.len()])
            .unwrap_or_default();
        if let Some(plan) = &self.plan {
            tracing::info!("[BuildReminder] {key}: {} step(s) in plan", plan.steps.len());
        }
    }

    /// A step counts as bought once every item in it is owned — including as a
    /// component of something bigger, so a Dark Seal step stops nagging after it
    /// becomes Mejai's.
    fn is_step_bought(&self, step: &build_paths::ResolvedStep) -> bool {
        step.items
            .iter()
            .all(|item| item.ownership_ids.iter().any(|id| self.owned.contains(id)))
    }

    /// One poll of the live client. Returns a reminder when this update crosses
    /// a threshold.
    pub fn handle_snapshot(&mut self, snapshot: &Snapshot) -> Option<Reminder> {
        if let Some(gold) = snapshot.current_gold() {
            self.gold = gold;
        }
        if let Some(me) = snapshot.me() {
            if let Some(key) =
                champion_data::resolve_champion_key(me.raw_champion_name.as_deref(), me.champion_name.as_deref())
            {
                if Some(&key) != self.champ_key.as_ref() {
                    self.champ_key = Some(key);
                    self.plan = None; // re-resolved below
                }
            }
            self.owned = me.item_ids();
        }
        self.evaluate()
    }

    /// Only ever looks at the first step still outstanding: a plan is a
    /// sequence, so hitting 1300g doesn't mean skipping the 650g step you never
    /// bought. Crossing back below a threshold re-arms that step, which turns
    /// "you forgot your Dark Seal" into a second ping on the next back rather
    /// than silence.
    fn evaluate(&mut self) -> Option<Reminder> {
        if !self.enabled || self.champ_key.is_none() {
            return None;
        }
        let needs_plan = match (&self.plan, &self.champ_key) {
            (Some(plan), Some(key)) => &plan.champ_key != key,
            (None, _) => true,
            _ => false,
        };
        if needs_plan {
            self.load_plan();
        }
        let plan = self.plan.clone()?;

        for (i, step) in plan.steps.iter().enumerate() {
            let state = self.steps[i];
            if state.skipped || self.is_step_bought(step) {
                continue;
            }
            if self.gold < step.gold {
                self.steps[i].armed = true;
                return None;
            }
            if !state.armed {
                return None;
            }
            let now = self.clock.now_ms();
            if now.saturating_sub(self.last_notify_at) < MIN_NOTIFY_GAP_MS {
                return None; // retried on the next poll
            }
            self.steps[i].armed = false;
            self.last_notify_at = now;
            return Some(Reminder {
                index: i,
                gold: step.gold,
                current_gold: self.gold,
                total_steps: plan.steps.len(),
                champ_key: plan.champ_key.clone(),
                items: step
                    .items
                    .iter()
                    .map(|it| ReminderItem { id: it.id, name: it.name.clone(), cost: it.cost })
                    .collect(),
            });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use crate::test_support::Sandbox;

    struct FakeClock(Arc<AtomicU64>);
    impl Clock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct Fixture {
        clock: Arc<AtomicU64>,
        reminder: BuildReminder,
        _sandbox: Sandbox,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let sandbox = Sandbox::new(tag);
            build_paths::set(
                "Ahri",
                &[
                    build_paths::Step { items: vec![1001, 1082], gold: 0, auto_gold: true },
                    build_paths::Step { items: vec![3802], gold: 1300, auto_gold: false },
                ],
            )
            .unwrap();

            let clock = Arc::new(AtomicU64::new(1_000_000));
            let reminder = BuildReminder::new(Box::new(FakeClock(clock.clone())));
            Self { clock, reminder, _sandbox: sandbox }
        }

        fn advance(&self, ms: u64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }

        fn snap(&mut self, gold: i64, items: &[i64]) -> Option<Reminder> {
            self.snap_champ(gold, items, "Ahri")
        }

        fn snap_champ(&mut self, gold: i64, items: &[i64], champ: &str) -> Option<Reminder> {
            let snapshot = crate::live_client::Snapshot::for_tests("Tester#EUW", "Tester", champ, gold, items);
            self.reminder.handle_snapshot(&snapshot)
        }
    }

    #[test]
    fn stays_quiet_below_the_threshold() {
        let mut f = Fixture::new("below");
        assert!(f.snap(400, &[]).is_none());
    }

    #[test]
    fn fires_once_the_threshold_is_reached() {
        let mut f = Fixture::new("fire");
        let r = f.snap(654, &[]).expect("should fire at 654g");
        assert_eq!(r.title(), "Buy: Boots + Dark Seal");
        assert_eq!(r.body(), "650g reached — step 1/2");
        assert_eq!(r.current_gold, 654);
        assert_eq!(r.items.len(), 2);
    }

    #[test]
    fn does_not_repeat_while_disarmed() {
        let mut f = Fixture::new("once");
        assert!(f.snap(654, &[]).is_some());
        f.advance(10_000);
        assert!(f.snap(700, &[]).is_none());
    }

    #[test]
    fn holds_back_a_second_step_inside_the_gap() {
        let mut f = Fixture::new("gap");
        assert!(f.snap(654, &[]).is_some());
        // Dips and comes back inside six seconds: re-armed, but not re-fired.
        f.advance(1_000);
        assert!(f.snap(120, &[]).is_none());
        assert!(f.snap(680, &[]).is_none());
    }

    #[test]
    fn re_pings_after_dipping_and_climbing_back() {
        let mut f = Fixture::new("rearm");
        assert!(f.snap(654, &[]).is_some());
        f.advance(7_000);
        assert!(f.snap(120, &[]).is_none());
        assert!(f.snap(680, &[]).is_some(), "you still haven't bought it");
    }

    #[test]
    fn a_bought_step_is_skipped_and_the_next_one_takes_over() {
        let mut f = Fixture::new("bought");
        assert!(f.snap(700, &[1001, 1082]).is_none());
        f.advance(7_000);
        let r = f.snap(1400, &[1001, 1082]).expect("step 2 fires");
        assert_eq!(r.title(), "Buy: Lost Chapter");
        assert_eq!(r.index, 1);
    }

    #[test]
    fn an_upgraded_item_still_counts_as_bought() {
        let mut f = Fixture::new("upgrade");
        // Ionian Boots + Mejai's: both steps' items were built into something.
        assert!(f.snap(700, &[3158, 3041]).is_none());
    }

    #[test]
    fn a_skipped_step_never_fires_again() {
        let mut f = Fixture::new("skip");
        assert!(f.snap(700, &[]).is_some());
        f.reminder.skip_step(0);
        f.advance(7_000);
        assert!(f.snap(200, &[]).is_none());
        assert!(f.snap(700, &[]).is_none());
    }

    #[test]
    fn a_champion_without_a_plan_stays_quiet() {
        let mut f = Fixture::new("noplan");
        assert!(f.snap_champ(5000, &[], "Teemo").is_none());
    }

    #[test]
    fn the_master_switch_silences_everything() {
        let mut f = Fixture::new("off");
        f.reminder.enabled = false;
        assert!(f.snap(5000, &[]).is_none());
        f.reminder.enabled = true;
        assert!(f.snap(5000, &[]).is_some());
    }

    #[test]
    fn reset_clears_state_between_matches() {
        let mut f = Fixture::new("reset");
        assert!(f.snap(700, &[]).is_some());
        f.reminder.reset();
        assert_eq!(f.reminder.champion(), None);
        assert!(f.snap(700, &[]).is_some(), "a fresh match pings again");
    }

    #[test]
    fn switching_champion_reloads_the_plan() {
        let mut f = Fixture::new("switch");
        assert!(f.snap_champ(5000, &[], "Teemo").is_none());
        f.advance(7_000);
        assert!(f.snap_champ(700, &[], "Ahri").is_some());
        assert_eq!(f.reminder.champion(), Some("Ahri"));
    }
}
