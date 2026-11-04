/**
 * The dictionaries, split by page (rebuild-proposal.md 8.3). Each page file
 * exports `zh` and an `en` typed to cover every Chinese key.
 */
import * as modelCalls from './pages/model-calls';
import * as servicePricing from './pages/service-pricing';
import * as knowledgeCosts from './pages/knowledge-costs';
import * as pricingAdmin from './pages/pricing-admin';
import * as admin from './pages/admin';
import * as firecrawl from './pages/firecrawl';
import * as billing from './pages/billing';
import * as chat from './pages/chat';
import * as common from './pages/common';
import * as dashboard from './pages/dashboard';
import * as knowledge from './pages/knowledge';
import * as legal from './pages/legal';
import * as login from './pages/login';
import * as reeSetup from './pages/ree-setup';
import * as rees from './pages/rees';
import * as settings from './pages/settings';
import * as site from './pages/site';
import * as conversations from './pages/conversations';
import * as discover from './pages/discover';
import * as roles from './pages/roles';
import * as statistics from './pages/statistics';
import * as notices from './pages/notices';
import * as console from './pages/console';
import * as consoleUsers from './pages/console-users';
import * as consoleRees from './pages/console-rees';
import * as payouts from './pages/payouts';
import * as consolePayouts from './pages/console-payouts';
import * as video from './pages/video';
import type { Locale } from './locale';

/* Step 5's pages sit in their own spread, so other steps' additions to the first object merge cleanly. */
const step5 = { roles, statistics, notices, console, consoleUsers, consoleRees };
const step6 = { payouts, consolePayouts };
/* Step 7's page sits in its own spread too. */
const step7 = { video };
const pages = { servicePricing, modelCalls, knowledgeCosts, pricingAdmin, common, login, dashboard, rees, reeSetup, knowledge, chat, settings, billing, site, legal, admin, firecrawl, conversations, discover, ...step5, ...step6, ...step7 };

type Pages = typeof pages;
export type Messages = { [K in keyof Pages]: Pages[K]['en'] };

export function messages(locale: Locale): Messages {
  return Object.fromEntries(Object.entries(pages).map(([name, page]) => [name, page[locale]])) as Messages;
}

export type { Locale };
