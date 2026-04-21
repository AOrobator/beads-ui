import { html, render } from 'lit-html';
import { createListSelectors } from '../data/list-selectors.js';
import { createIssueIdRenderer } from '../utils/issue-id-renderer.js';
import { createIssueRowRenderer } from './issue-row.js';

/**
 * @typedef {{ id: string, title?: string, status?: string, priority?: number, issue_type?: string, assignee?: string, created_at?: number, updated_at?: number }} IssueLite
 */

/**
 * @typedef {'priority'|'status'} EpicSortMode
 */

/**
 * @typedef {'asc'|'desc'} EpicSortDirection
 */

/**
 * @typedef {{ mode: EpicSortMode, direction: EpicSortDirection }} EpicSortState
 */

/**
 * Epics view (push-only):
 * - Derives epic groups from the local issues store (no RPC reads).
 * - Subscribes to `tab:epics` for top-level membership.
 * - On expand, subscribes to `detail:{id}` (issue-detail) for the epic.
 * - Renders children from the epic detail's `dependents` list.
 * - Provides inline edits via mutations; UI re-renders on push.
 *
 * @param {HTMLElement} mount_element
 * @param {{ updateIssue: (input: any) => Promise<any> }} data
 * @param {(id: string) => void} goto_issue - Navigate to issue detail.
 * @param {{ subscribeList: (client_id: string, spec: { type: string, params?: Record<string, string|number|boolean> }) => Promise<() => Promise<void>>, selectors: { getIds: (client_id: string) => string[], count?: (client_id: string) => number } }} [subscriptions]
 * @param {{ snapshotFor?: (client_id: string) => any[], subscribe?: (fn: () => void) => () => void }} [issue_stores]
 */
export function createEpicsView(
  mount_element,
  data,
  goto_issue,
  subscriptions = undefined,
  issue_stores = undefined
) {
  /** @type {any[]} */
  let groups = [];
  /** @type {Set<string>} */
  const expanded = new Set();
  /** @type {Set<string>} */
  const loading = new Set();
  /** @type {Map<string, () => Promise<void>>} */
  const epic_unsubs = new Map();
  /** @type {Map<string, EpicSortState>} */
  const epic_sort_states = new Map();
  // Centralized selection helpers
  const selectors = issue_stores ? createListSelectors(issue_stores) : null;
  // Live re-render on pushes: recompute groups when stores change
  if (selectors) {
    selectors.subscribe(() => {
      const had_none = groups.length === 0;
      groups = buildGroupsFromSnapshot();
      doRender();
      // Auto-expand first epic when transitioning from empty to non-empty
      if (had_none && groups.length > 0) {
        const first_id = String(groups[0].epic?.id || '');
        if (first_id && !expanded.has(first_id)) {
          void toggle(first_id);
        }
      }
    });
  }

  // Shared row renderer used for children rows
  const renderRow = createIssueRowRenderer({
    navigate: (id) => goto_issue(id),
    onUpdate: updateInline,
    requestRender: doRender,
    getSelectedId: () => null,
    row_class: 'epic-row'
  });

  function doRender() {
    render(template(), mount_element);
  }

  function template() {
    if (!groups.length) {
      return html`<div class="panel__header muted">No epics found.</div>`;
    }
    return html`${groups.map((g) => groupTemplate(g))}`;
  }

  /**
   * @param {any} g
   */
  function groupTemplate(g) {
    const epic = g.epic || {};
    const id = String(epic.id || '');
    const is_open = expanded.has(id);
    const sort_state = getSortState(id);
    // Compose children via selectors
    const list = selectors
      ? selectors.selectEpicChildren(id, sort_state.mode, sort_state.direction)
      : [];
    const is_loading = loading.has(id);
    return html`
      <div class="epic-group" data-epic-id=${id}>
        <div
          class="epic-header"
          @click=${() => toggle(id)}
          role="button"
          tabindex="0"
          aria-expanded=${is_open}
        >
          <div class="epic-header__main">
            ${createIssueIdRenderer(id, { class_name: 'mono' })}
            <span class="epic-header__title text-truncate"
              >${epic.title || '(no title)'}</span
            >
          </div>
          <span class="epic-progress">
            <progress
              value=${Number(g.closed_children || 0)}
              max=${Math.max(1, Number(g.total_children || 0))}
            ></progress>
            <span class="muted mono"
              >${g.closed_children}/${g.total_children}</span
            >
          </span>
        </div>
        ${is_open
          ? html`<div class="epic-children">
              ${is_loading
                ? null
                : html`<div class="epic-children__toolbar">
                    <div class="epic-sort-bar">
                      <div class="epic-sort-bar__header">
                        <span class="epic-sort-bar__label">Sort tickets</span>
                        <span class="epic-sort-bar__current"
                          >${describeSortState(sort_state)}</span
                        >
                      </div>
                      <div class="epic-sort-bar__controls" role="toolbar">
                        ${sortModeButton(id, sort_state, 'priority')}
                        ${sortModeButton(id, sort_state, 'status')}
                      </div>
                    </div>
                  </div>`}
              ${is_loading
                ? html`<div class="muted">Loading…</div>`
                : list.length === 0
                  ? html`<div class="muted">No issues found</div>`
                  : html`<table class="table epic-issues-table">
                      <colgroup>
                        <col style="width: 92px" />
                        <col style="width: 96px" />
                        <col style="width: 38%" />
                        <col style="width: 110px" />
                        <col style="width: 132px" />
                        <col style="width: 112px" />
                        <col style="width: 72px" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Type</th>
                          <th>Title</th>
                          <th>Status</th>
                          <th>Assignee</th>
                          <th>Priority</th>
                          <th>Deps</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${list.map((it) => renderRow(it))}
                      </tbody>
                    </table>`}
            </div>`
          : null}
      </div>
    `;
  }

  /**
   * @param {string} id
   * @param {{ [k: string]: any }} patch
   */
  async function updateInline(id, patch) {
    try {
      await data.updateIssue({ id, ...patch });
      // Re-render; view will update on subsequent push
      doRender();
    } catch {
      // swallow; UI remains
    }
  }

  /**
   * @param {string} epic_id
   * @returns {EpicSortState}
   */
  function getSortState(epic_id) {
    return (
      epic_sort_states.get(epic_id) || { mode: 'priority', direction: 'asc' }
    );
  }

  /**
   * @param {string} epic_id
   * @param {EpicSortState} current_state
   * @param {EpicSortMode} next_mode
   */
  function sortModeButton(epic_id, current_state, next_mode) {
    const is_active = current_state.mode === next_mode;
    const preview_direction = is_active
      ? toggleDirection(current_state.direction)
      : 'asc';
    return html`<button
      type="button"
      class="epic-sort-chip ${is_active ? 'is-active' : ''}"
      aria-pressed=${is_active}
      title=${buttonTitle(next_mode, preview_direction, is_active)}
      @click=${() => toggleSortState(epic_id, next_mode)}
    >
      ${buttonLabel(next_mode, is_active ? current_state.direction : null)}
    </button>`;
  }

  /**
   * @param {string} epic_id
   * @param {EpicSortMode} next_mode
   */
  function toggleSortState(epic_id, next_mode) {
    const current_state = getSortState(epic_id);
    /** @type {EpicSortState} */
    const next_state =
      current_state.mode === next_mode
        ? {
            mode: next_mode,
            direction: toggleDirection(current_state.direction)
          }
        : { mode: next_mode, direction: 'asc' };
    epic_sort_states.set(epic_id, next_state);
    doRender();
  }

  /**
   * @param {EpicSortDirection} direction
   * @returns {EpicSortDirection}
   */
  function toggleDirection(direction) {
    return direction === 'asc' ? 'desc' : 'asc';
  }

  /**
   * @param {EpicSortState} sort_state
   */
  function describeSortState(sort_state) {
    return `${modeLabel(sort_state.mode)}: ${directionLabel(
      sort_state.mode,
      sort_state.direction
    )}`;
  }

  /**
   * @param {EpicSortMode} mode
   * @param {EpicSortDirection|null} direction
   */
  function buttonLabel(mode, direction) {
    if (!direction) {
      return modeLabel(mode);
    }
    return `${modeLabel(mode)}: ${directionLabel(mode, direction)}`;
  }

  /**
   * @param {EpicSortMode} mode
   */
  function modeLabel(mode) {
    return mode === 'status' ? 'Status' : 'Priority';
  }

  /**
   * @param {EpicSortMode} mode
   * @param {EpicSortDirection} direction
   */
  function directionLabel(mode, direction) {
    if (mode === 'status') {
      return direction === 'asc' ? 'Open to closed' : 'Closed to open';
    }
    return direction === 'asc' ? 'High to low' : 'Low to high';
  }

  /**
   * @param {EpicSortMode} mode
   * @param {EpicSortDirection} preview_direction
   * @param {boolean} is_active
   */
  function buttonTitle(mode, preview_direction, is_active) {
    const action = is_active ? 'Reverse to' : 'Sort by';
    return `${action} ${modeLabel(mode).toLowerCase()} ${directionLabel(
      mode,
      preview_direction
    ).toLowerCase()}`;
  }

  /**
   * @param {string} epic_id
   */
  async function toggle(epic_id) {
    if (!expanded.has(epic_id)) {
      expanded.add(epic_id);
      loading.add(epic_id);
      doRender();
      // Subscribe to epic detail; children are rendered from `dependents`
      if (subscriptions && typeof subscriptions.subscribeList === 'function') {
        try {
          // Register store first to avoid dropping the initial snapshot
          try {
            if (issue_stores && /** @type {any} */ (issue_stores).register) {
              /** @type {any} */ (issue_stores).register(`detail:${epic_id}`, {
                type: 'issue-detail',
                params: { id: epic_id }
              });
            }
          } catch {
            // ignore
          }
          const u = await subscriptions.subscribeList(`detail:${epic_id}`, {
            type: 'issue-detail',
            params: { id: epic_id }
          });
          epic_unsubs.set(epic_id, u);
        } catch {
          // ignore subscription failures
        }
      }
      // Mark as not loading after subscribe attempt; membership will stream in
      loading.delete(epic_id);
    } else {
      expanded.delete(epic_id);
      // Unsubscribe when collapsing
      if (epic_unsubs.has(epic_id)) {
        try {
          const u = epic_unsubs.get(epic_id);
          if (u) {
            await u();
          }
        } catch {
          // ignore
        }
        epic_unsubs.delete(epic_id);
        try {
          if (issue_stores && /** @type {any} */ (issue_stores).unregister) {
            /** @type {any} */ (issue_stores).unregister(`detail:${epic_id}`);
          }
        } catch {
          // ignore
        }
      }
    }
    doRender();
  }

  /** Build groups from the current `tab:epics` snapshot. */
  function buildGroupsFromSnapshot() {
    /** @type {IssueLite[]} */
    const epic_entities =
      issue_stores && issue_stores.snapshotFor
        ? /** @type {IssueLite[]} */ (
            issue_stores.snapshotFor('tab:epics') || []
          )
        : [];
    const next_groups = [];
    for (const epic of epic_entities) {
      const dependents = Array.isArray(/** @type {any} */ (epic).dependents)
        ? /** @type {any[]} */ (/** @type {any} */ (epic).dependents)
        : [];
      // Prefer explicit counters when provided by server; otherwise derive
      const has_total = Number.isFinite(
        /** @type {any} */ (epic).total_children
      );
      const has_closed = Number.isFinite(
        /** @type {any} */ (epic).closed_children
      );
      const total = has_total
        ? Number(/** @type {any} */ (epic).total_children) || 0
        : dependents.length;
      let closed = has_closed
        ? Number(/** @type {any} */ (epic).closed_children) || 0
        : 0;
      if (!has_closed) {
        for (const d of dependents) {
          if (String(d.status || '') === 'closed') {
            closed++;
          }
        }
      }
      next_groups.push({
        epic,
        total_children: total,
        closed_children: closed
      });
    }
    return next_groups;
  }

  return {
    async load() {
      groups = buildGroupsFromSnapshot();
      doRender();
      // Auto-expand first epic on screen
      try {
        if (groups.length > 0) {
          const first_id = String(groups[0].epic?.id || '');
          if (first_id && !expanded.has(first_id)) {
            // This will render and load children lazily
            await toggle(first_id);
          }
        }
      } catch {
        // ignore auto-expand failures
      }
    }
  };
}
