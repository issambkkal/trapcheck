// Registers Trap Check's operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
// The actions only wrap App.page: the rules and thresholds live in app.js.
import { App } from "./app.js";

/**
 * Describes Trap Check's operations as actions the agents can call.
 *
 * Each action wraps a function the page's own form and buttons use, so the assistant and
 * the manual page share one set of rules. The runtime validates arguments against
 * inputSchema before execute runs. Nothing here is irreversible: checks only read public
 * data and change what the page shows.
 */
class SiteActions {
  /**
   * Register every site action with the runtime.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(SiteActions.factsAction());
    actions.register(SiteActions.stateAction());
    actions.register(SiteActions.checkTokenAction());
  }

  /**
   * Describe the read action for what the site checks and its limits.
   *
   * :return: The action definition.
   */
  static factsAction() {
    return {
      name: "get_site_facts",
      description: "Read what Trap Check checks: every red/amber rule with its threshold, how verdicts are decided, the data sources and what the site cannot do.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: SiteActions.readFacts,
    };
  }

  /**
   * Return the site's rules, sources and limits.
   *
   * :return: Plain JSON facts.
   */
  static readFacts() {
    return App.page.getFacts();
  }

  /**
   * Describe the read action for the report on the page and the recent checks.
   *
   * :return: The action definition.
   */
  static stateAction() {
    return {
      name: "get_page_state",
      description: "Read the report currently shown on the page and the visitor's recent checks in this browser (address, symbol, verdict, flag counts, time).",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: SiteActions.readState,
    };
  }

  /**
   * Return the current report and recent checks.
   *
   * :return: Plain JSON page state.
   */
  static readState() {
    return App.page.getState();
  }

  /**
   * Describe the check: it reads public data and shows the report on the page.
   *
   * :return: The action definition.
   */
  static checkTokenAction() {
    return {
      name: "check_token",
      description: "Check one Solana token by its mint address with live DexScreener and RugCheck data, show the report on the page and return it: verdict, each red/amber flag, RugCheck risks, the numbers and source links. Returns ok false with a reason for an invalid address. Takes a few seconds.",
      // It changes only what the page shows and the recent list, which the visitor can clear.
      effect: "write",
      timeoutMs: 30000,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["address"],
        properties: {
          address: {
            type: "string",
            minLength: 32,
            maxLength: 44,
            description: "The token's Solana mint address exactly as the visitor gave it (32 to 44 base58 characters). Not a name or ticker.",
          },
        },
      },
      execute: SiteActions.checkToken,
    };
  }

  /**
   * Run the same check as the page's form.
   *
   * :param args: The validated arguments with address.
   * :return: The report, or {ok: false, reason}.
   */
  static checkToken(args) {
    return App.page.checkToken(args.address);
  }
}

// The runtime calls the module's registerActions export.
export const registerActions = SiteActions.registerActions;
