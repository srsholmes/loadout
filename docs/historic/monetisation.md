# Monetisation

## What Won't Work

- **Charging for the loader itself** — Someone forks it and the fork becomes the community standard
- **Ads in the UI** — Received as malware, community revolt
- **Selling user data** — Ethically wrong and trust-destroying

The loader must be free and open source. Revenue comes from value-added services around it.

## Viable Paths

### 1. Verified Plugin Programme

**Model:** Charge commercial plugin authors a listing fee or revenue share for a "Verified" tier.

**What verified gets you:**
- Verified badge and featured placement in the plugin store
- Guaranteed compatibility testing against SteamOS updates
- Access to CI infrastructure
- Priority support

Free plugins stay free and listed normally. This is a quality/trust signal, not a paywall.

**Revenue potential:** 10-20 commercial plugins paying GBP 500-2,000/year.

### 2. Companion App (Freemium)

**Model:** The companion app is a separate commercial product that works with the open source loader.

| Tier | Features |
|---|---|
| **Free** | Basic remote control, current game info, battery/TDP at a glance |
| **Pro** (GBP 2-4/month or GBP 15-20 one-time) | Push notifications, multi-device sync, session history, per-game stats, cloud backup of plugin configs |

Natural growth path to other devices (ROG Ally, Legion Go, other handhelds).

### 3. Hosted Config Sync

**Model:** Obsidian Sync model for plugin configurations.

| Tier | Features |
|---|---|
| **Free** | Sync configs for up to 3 plugins, manual backup/restore |
| **Pro** (GBP 2-3/month) | Unlimited sync, automatic cloud backup, multi-device sync, config history/rollback |

**Implementation:** Key-value store per user with versioning (Cloudflare KV or simple Postgres).

### 4. Sponsorship and Open Source Funding

- **GitHub Sponsors** — Individual and corporate tiers
- **Corporate sponsors** — Proton-related companies, game publishers, peripheral manufacturers
- **Open Collective** — Transparent finances for the project

### 5. Developer Tooling as a Service

**Model:** Expo for React Native / Fastlane for iOS, but for Loadout plugins.

- Cloud CI with SteamOS compatibility testing
- Automated store submission and signing
- Beta channel distribution
- Analytics: install counts, error rates, SteamOS version distribution
- Free tier for open source plugins, paid for commercial

### 6. Consulting and Custom Development

- Custom plugins for companies (peripheral manufacturers, game publishers)
- Integration work between Steam and other platforms
- Speaking/content about Linux gaming

## Priority Ranking

Ordered by likelihood of generating meaningful revenue:

1. **Companion app Pro tier** — Clearest value proposition, proven freemium model
2. **Config sync hosted service** — Low cost to run, recurring revenue, solves real pain
3. **Verified plugin store listings** — Depends on ecosystem size, longer runway
4. **Sponsorships** — Grows with project visibility
5. **Developer tooling** — Requires mature ecosystem
6. **Consulting** — Opportunistic, not scalable
