// Renders the query editor from the model.
//
// Conventions (handled by delegated listeners in app.js):
//   inputs:  data-path="<model path>" data-bind="text|check|select"
//            data-rerender  → structural change, re-render after update
//   buttons: data-action="<action>" data-path="<model path>" [data-arg]
//   <details data-section="<key>"> remember their open state across renders
//
// Only this module decides what the editor looks like; it never mutates the model.

import { h } from './dom.js';
import { getDialect } from '../dialects.js';
import { OPERATORS, JOIN_TYPES, SET_OPERATORS, AGGREGATES, WINDOW_FUNCTIONS, joinPath } from '../model.js';

const SET_OPERATOR_LABELS = {
    'UNION': 'UNION — rows in either query (no duplicates)',
    'UNION ALL': 'UNION ALL — rows in either query (keep duplicates)',
    'INTERSECT': 'INTERSECT — rows in both queries',
    'INTERSECT ALL': 'INTERSECT ALL — rows in both, keep duplicates',
    'EXCEPT': 'EXCEPT — rows in the first query but not this one',
    'EXCEPT ALL': 'EXCEPT ALL — like EXCEPT, keep duplicates'
};

/** @type {[string, string[]][]} */
const WINDOW_GROUPS = [
    ['Ranking', ['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST', 'NTILE']],
    ['Offset', ['LAG', 'LEAD']],
    ['Value', ['FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE']],
    ['Aggregate', ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT']]
];

const WINDOW_ARG_PLACEHOLDERS = {
    ntile: 'number of groups, e.g. 4',
    offset: 'column[, offset[, default]], e.g. salary, 1, 0',
    value: 'column, e.g. salary',
    nth: 'column, position, e.g. salary, 2',
    aggregate: 'column, e.g. amount'
};
import { MAX_NESTING_DEPTH } from '../validation.js';

const PARAM_PLACEHOLDER = 'parameter name (optional)';

const ASSIGNMENT_TYPES = [['value', 'Value'], ['column', 'Column / expression'], ['param', 'Parameter']];

const fieldId = (path) => `f-${path.replace(/[^\w-]/g, '-')}`;

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * @param {string} path
 * @param {string} value
 * @param {{ label?: string, placeholder?: string, hidden?: boolean, numeric?: boolean, className?: string, describedBy?: string }} [options]
 */
function textInput(path, value, { label, placeholder = '', hidden = false, numeric = false, className = '', describedBy } = {}) {
    return h('input', {
        type: 'text',
        id: fieldId(path),
        class: `input ${className}`.trim(),
        value: value ?? '',
        placeholder,
        autocomplete: 'off',
        spellcheck: 'false',
        inputmode: numeric ? 'numeric' : null,
        'aria-label': hidden ? label : null,
        'aria-describedby': describedBy,
        dataset: { path, bind: 'text' }
    });
}

/**
 * @param {string} path
 * @param {string} value
 * @param {{ label?: string, hint?: string, required?: boolean, placeholder?: string, numeric?: boolean }} [options]
 */
function field(path, value, { label, hint, required, ...options } = {}) {
    const hintId = hint ? `${fieldId(path)}-hint` : undefined;
    return h('div', { class: 'field' },
        h('label', { class: 'field-label', for: fieldId(path) }, label, required ? h('span', { class: 'required', 'aria-hidden': 'true' }, ' *') : null),
        textInput(path, value, { label, describedBy: hintId, ...options }),
        hint ? h('p', { class: 'field-hint', id: hintId }, hint) : null
    );
}

/**
 * @param {string} path
 * @param {string} value
 * @param {any[][]} choices [value, label, disabled?]
 * @param {{ label?: string, rerender?: boolean, className?: string }} [options]
 */
function select(path, value, choices, { label, rerender = false, className = '' } = {}) {
    return h('select', {
        id: fieldId(path),
        class: `select ${className}`.trim(),
        'aria-label': label,
        dataset: { path, bind: 'select', rerender: rerender || null }
    }, choices.map(([optionValue, optionLabel, disabled]) => h('option', {
        value: optionValue, selected: optionValue === value, disabled: disabled || null
    }, optionLabel)));
}

/**
 * @param {string} path
 * @param {boolean} checked
 * @param {string} label
 * @param {{ rerender?: boolean }} [options]
 */
function checkbox(path, checked, label, { rerender = false } = {}) {
    return h('label', { class: 'check' },
        h('input', { type: 'checkbox', id: fieldId(path), checked: Boolean(checked), dataset: { path, bind: 'check', rerender: rerender || null } }),
        h('span', {}, label)
    );
}

/**
 * @param {string} text
 * @param {string} action
 * @param {string} path
 * @param {{ arg?: string, variant?: string, label?: string, icon?: string }} [options]
 */
function button(text, action, path, { arg, variant = 'ghost', label, icon } = {}) {
    return h('button', {
        type: 'button',
        class: `btn btn-${variant}${icon ? ' btn-icon' : ''}`,
        'aria-label': label,
        title: label,
        dataset: { action, path, arg }
    }, icon ? h('span', { 'aria-hidden': 'true' }, icon) : text);
}

function rowTools(itemPath, index, count, noun) {
    return h('div', { class: 'row-tools' },
        count > 1 ? button('', 'move-up', itemPath, { icon: '↑', label: `Move ${noun} ${index + 1} up` }) : null,
        count > 1 ? button('', 'move-down', itemPath, { icon: '↓', label: `Move ${noun} ${index + 1} down` }) : null,
        button('', 'remove-item', itemPath, { icon: '✕', label: `Remove ${noun} ${index + 1}`, variant: 'danger-ghost' })
    );
}

/**
 * @param {string} key
 * @param {string} title
 * @param {{ open?: boolean, count?: number, description?: string }} options
 * @param {...any} content
 */
function section(key, title, { open, count, description } = {}, ...content) {
    return h('details', { class: 'section', open, dataset: { section: key } },
        h('summary', { class: 'section-summary' },
            h('span', { class: 'section-title' }, title),
            count ? h('span', { class: 'badge', 'aria-label': `${count} item${count === 1 ? '' : 's'}` }, String(count)) : null
        ),
        h('div', { class: 'section-body' },
            description ? h('p', { class: 'section-description' }, description) : null,
            content
        )
    );
}

function addBar(...buttons) {
    return h('div', { class: 'add-bar' }, buttons);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {any} workspace
 * @param {{ isOpen: (key: string, fallback: boolean) => boolean, dialect?: () => any }} ui
 */
export function renderEditor(workspace, ui) {
    const type = workspace.type;
    const query = workspace[type];
    const r = new Renderer(ui);
    switch (type) {
        case 'select': return r.select(query, 'select', { depth: 0, top: true, branch: false });
        case 'insert': return r.insert(query, 'insert');
        case 'update': return r.update(query, 'update');
        case 'delete': return r.delete(query, 'delete');
        default: return h('p', {}, 'Unknown query type.');
    }
}

class Renderer {
    constructor(ui) {
        this.ui = ui;
        // The selected dialect: options it can't express stay available (the
        // query model is never changed behind the user's back) but say so
        this.dialect = ui.dialect ? ui.dialect() : getDialect();
    }

    /** An option label, marked when the selected dialect doesn't support it. */
    option(text, supported) {
        return supported ? text : `${text} (not in ${this.dialect.shortLabel})`;
    }

    section(key, title, options, ...content) {
        return section(key, title, { ...options, open: this.ui.isOpen(key, Boolean(options.open)) }, ...content);
    }

    // ------------------------------------------------------------------ SELECT

    select(q, path, ctx) {
        const nested = ctx.depth > 0;
        const hasGrouping = q.groupBy.length > 0 || q.having.items.length > 0;
        const hasSorting = q.orderBy.length > 0 || q.limit !== '' || q.offset !== '';

        return h('div', { class: `select-editor${nested ? ' nested' : ''}`, dataset: { path } },
            ctx.top ? this.section(`${path}:ctes`, 'WITH (common table expressions)', {
                open: q.ctes.length > 0, count: q.ctes.length,
                description: 'Name a query once and use it like a table in the main query.'
            }, this.ctes(q, path, ctx)) : null,

            this.section(`${path}:columns`, 'Columns', { open: true, count: q.columns.length }, this.columns(q, path)),
            this.section(`${path}:from`, 'FROM', { open: true }, this.source(q.from, joinPath(path, 'from'), ctx, 'FROM')),
            this.section(`${path}:joins`, 'Joins', { open: q.joins.length > 0, count: q.joins.length }, this.joins(q, path, ctx)),
            this.section(`${path}:where`, 'WHERE (filter rows)', { open: q.where.items.length > 0, count: q.where.items.length },
                this.group(q.where, joinPath(path, 'where'), ctx, { clause: 'WHERE', root: true })),
            this.section(`${path}:grouping`, 'GROUP BY & HAVING', { open: hasGrouping, count: q.groupBy.length + q.having.items.length },
                this.grouping(q, path, ctx)),
            ctx.branch ? null : this.section(`${path}:sorting`, `ORDER BY, ${this.dialect.ui.limitLabel} & OFFSET`, { open: hasSorting, count: q.orderBy.length },
                this.sorting(q, path)),
            ctx.branch ? null : this.section(`${path}:setops`, 'UNION / INTERSECT / EXCEPT', {
                open: q.setOps.length > 0, count: q.setOps.length,
                description: 'Combine this query with other SELECT queries. Each must return the same number of columns.'
            }, this.setOps(q, path, ctx))
        );
    }

    ctes(q, path, ctx) {
        return [
            h('ol', { class: 'item-list' }, q.ctes.map((cte, i) => {
                const cPath = joinPath(path, 'ctes', i);
                return h('li', { class: 'card', dataset: { path: cPath } },
                    h('div', { class: 'card-header' },
                        field(joinPath(cPath, 'name'), cte.name, { label: `CTE ${i + 1} name`, placeholder: 'e.g. recent_orders', required: true }),
                        rowTools(cPath, i, q.ctes.length, 'CTE')
                    ),
                    this.select(cte.query, joinPath(cPath, 'query'), { depth: ctx.depth + 1, top: false, branch: false })
                );
            })),
            addBar(button('+ Add CTE', 'add-item', joinPath(path, 'ctes'), { arg: 'cte' }))
        ];
    }

    columns(q, path) {
        const cols = q.columns;
        return [
            checkbox(joinPath(path, 'distinct'), q.distinct, 'DISTINCT — remove duplicate rows'),
            h('ol', { class: 'item-list' }, cols.map((col, i) => {
                const cPath = joinPath(path, 'columns', i);
                const kindSelect = select(joinPath(cPath, 'kind'), col.kind, [['column', 'Column'], ['case', 'CASE'], ['window', 'Window']],
                    { label: `Column ${i + 1} type`, rerender: true, className: 'select-narrow' });
                if (col.kind === 'window') {
                    return this.windowColumn(col, cPath, i, cols.length, kindSelect);
                }
                if (col.kind === 'case') {
                    return h('li', { class: 'card', dataset: { path: cPath } },
                        h('div', { class: 'row' },
                            kindSelect,
                            textInput(joinPath(cPath, 'alias'), col.alias, { label: `Column ${i + 1} alias`, hidden: true, placeholder: 'AS alias' }),
                            rowTools(cPath, i, cols.length, 'column')),
                        h('ol', { class: 'item-list case-list' }, col.cases.map((c, j) => {
                            const wPath = joinPath(cPath, 'cases', j);
                            return h('li', { class: 'row', dataset: { path: wPath } },
                                h('span', { class: 'keyword' }, 'WHEN'),
                                textInput(joinPath(wPath, 'when'), c.when, { label: `Column ${i + 1} WHEN ${j + 1} condition`, hidden: true, placeholder: "e.g. salary > 50000", className: 'grow' }),
                                h('span', { class: 'keyword' }, 'THEN'),
                                textInput(joinPath(wPath, 'then'), c.then, { label: `Column ${i + 1} THEN ${j + 1} result`, hidden: true, placeholder: "e.g. 'High'", className: 'grow' }),
                                col.cases.length > 1 ? button('', 'remove-item', wPath, { icon: '✕', label: `Remove WHEN ${j + 1}`, variant: 'danger-ghost' }) : null
                            );
                        })),
                        h('div', { class: 'row' },
                            button('+ WHEN', 'add-item', joinPath(cPath, 'cases'), { arg: 'caseWhen' }),
                            h('span', { class: 'keyword' }, 'ELSE'),
                            textInput(joinPath(cPath, 'elseValue'), col.elseValue, { label: `Column ${i + 1} ELSE result`, hidden: true, placeholder: "optional, e.g. 'Low'", className: 'grow' })
                        ),
                        h('p', { class: 'field-hint' }, "CASE parts are SQL: write text in single quotes, e.g. 'High'.")
                    );
                }
                return h('li', { class: 'row column-row', dataset: { path: cPath } },
                    kindSelect,
                    select(joinPath(cPath, 'aggregate'), col.aggregate,
                        AGGREGATES.map(a => [a, a === '' ? 'No aggregate' : a === 'COUNT DISTINCT' ? 'COUNT(DISTINCT)' : a]),
                        { label: `Column ${i + 1} aggregate`, className: 'select-narrow' }),
                    textInput(joinPath(cPath, 'expr'), col.expr, {
                        label: `Column ${i + 1} name or expression`, hidden: true, className: 'grow',
                        placeholder: col.aggregate === 'COUNT' ? '* (all rows)' : 'column or expression'
                    }),
                    textInput(joinPath(cPath, 'alias'), col.alias, { label: `Column ${i + 1} alias`, hidden: true, placeholder: 'AS alias', className: 'alias' }),
                    rowTools(cPath, i, cols.length, 'column')
                );
            })),
            addBar(
                button('+ Column', 'add-item', joinPath(path, 'columns'), { arg: 'column' }),
                button('+ CASE column', 'add-item', joinPath(path, 'columns'), { arg: 'case' }),
                button('+ Window function', 'add-item', joinPath(path, 'columns'), { arg: 'window' })
            )
        ];
    }

    // FUNC(args) OVER (PARTITION BY … ORDER BY … frame)
    windowColumn(col, cPath, i, count, kindSelect) {
        const spec = WINDOW_FUNCTIONS[col.func] || WINDOW_FUNCTIONS.ROW_NUMBER;
        const n = `Column ${i + 1}`;
        const funcSelect = h('select', {
            id: fieldId(joinPath(cPath, 'func')),
            class: 'select select-op',
            'aria-label': `${n} window function`,
            dataset: { path: joinPath(cPath, 'func'), bind: 'select', rerender: true }
        }, WINDOW_GROUPS.map(([groupLabel, funcs]) => h('optgroup', { label: groupLabel },
            funcs.map(f => h('option', { value: f, selected: f === col.func },
                this.option(`${f}()`, f !== 'NTH_VALUE' || this.dialect.supports.nthValue))))));

        return h('li', { class: 'card', dataset: { path: cPath } },
            h('div', { class: 'row' },
                kindSelect,
                funcSelect,
                spec.args === 'none' ? null : textInput(joinPath(cPath, 'args'), col.args, {
                    label: `${n} function arguments`, hidden: true, className: 'grow',
                    placeholder: col.func === 'COUNT' ? 'column (empty = all rows)' : WINDOW_ARG_PLACEHOLDERS[spec.args]
                }),
                // Window aliases tend to be long (running_total, dept_rank)
                textInput(joinPath(cPath, 'alias'), col.alias, { label: `${n} alias`, hidden: true, placeholder: 'AS alias', className: 'alias alias-wide' }),
                rowTools(cPath, i, count, 'column')
            ),
            h('div', { class: 'window-over' },
                h('p', { class: 'subquery-label' }, 'OVER'),
                h('h4', { class: 'sub-heading' }, 'PARTITION BY'),
                h('ol', { class: 'item-list' }, col.partitionBy.map((p, j) => {
                    const pPath = joinPath(cPath, 'partitionBy', j);
                    return h('li', { class: 'row', dataset: { path: pPath } },
                        textInput(joinPath(pPath, 'expr'), p.expr, { label: `${n} partition column ${j + 1}`, hidden: true, placeholder: 'column', className: 'grow' }),
                        button('', 'remove-item', pPath, { icon: '✕', label: `Remove partition column ${j + 1}`, variant: 'danger-ghost' }));
                })),
                addBar(button('+ Partition column', 'add-item', joinPath(cPath, 'partitionBy'), { arg: 'groupBy' })),
                h('h4', { class: 'sub-heading' }, 'ORDER BY'),
                h('ol', { class: 'item-list' }, col.orderBy.map((o, j) => {
                    const oPath = joinPath(cPath, 'orderBy', j);
                    return h('li', { class: 'row', dataset: { path: oPath } },
                        textInput(joinPath(oPath, 'expr'), o.expr, { label: `${n} window order column ${j + 1}`, hidden: true, placeholder: 'column', className: 'grow' }),
                        select(joinPath(oPath, 'direction'), o.direction, [['ASC', 'Ascending'], ['DESC', 'Descending']], { label: `${n} window order ${j + 1} direction`, className: 'select-narrow' }),
                        button('', 'remove-item', oPath, { icon: '✕', label: `Remove window order column ${j + 1}`, variant: 'danger-ghost' }));
                })),
                addBar(button('+ Order column', 'add-item', joinPath(cPath, 'orderBy'), { arg: 'orderBy' })),
                spec.frame ? h('div', { class: 'row' },
                    h('label', { class: 'field-label', for: fieldId(joinPath(cPath, 'frame')) }, 'Frame'),
                    select(joinPath(cPath, 'frame'), col.frame, [
                        ['', 'Default'],
                        ['running', 'Running total (start → current row)'],
                        ['whole', 'Whole partition'],
                        ['moving', 'Moving (N rows back → current row)']
                    ], { rerender: true }),
                    col.frame === 'moving' ? textInput(joinPath(cPath, 'frameSize'), col.frameSize, {
                        label: `${n} preceding rows in the moving frame`, hidden: true, placeholder: 'N rows', numeric: true, className: 'alias'
                    }) : null
                ) : null
            )
        );
    }

    source(source, path, ctx, role) {
        const canNest = ctx.depth < MAX_NESTING_DEPTH;
        const kind = select(joinPath(path, 'kind'), source.kind,
            [['table', 'Table'], ['subquery', 'Subquery', !canNest && source.kind !== 'subquery']],
            { label: `${role} source type`, rerender: true, className: 'select-narrow' });
        if (source.kind === 'subquery') {
            return h('div', { class: 'source', dataset: { path } },
                h('div', { class: 'row' },
                    kind,
                    textInput(joinPath(path, 'alias'), source.alias, { label: `${role} subquery alias`, hidden: true, placeholder: 'AS alias (required)', className: 'alias' })
                ),
                h('div', { class: 'subquery' },
                    h('p', { class: 'subquery-label' }, `Subquery (${role})`),
                    this.select(source.query, joinPath(path, 'query'), { depth: ctx.depth + 1, top: false, branch: false }))
            );
        }
        return h('div', { class: 'source row', dataset: { path } },
            kind,
            textInput(joinPath(path, 'table'), source.table, { label: `${role} table name`, hidden: true, placeholder: 'table or schema.table', className: 'grow' }),
            textInput(joinPath(path, 'alias'), source.alias, { label: `${role} table alias`, hidden: true, placeholder: 'AS alias', className: 'alias' })
        );
    }

    joins(q, path, ctx) {
        return [
            h('ol', { class: 'item-list' }, q.joins.map((join, i) => {
                const jPath = joinPath(path, 'joins', i);
                return h('li', { class: 'card', dataset: { path: jPath } },
                    h('div', { class: 'card-header' },
                        select(joinPath(jPath, 'type'), join.type, JOIN_TYPES.map(t => [t, this.option(t, t !== 'FULL JOIN' || this.dialect.supports.fullJoin)]), { label: `Join ${i + 1} type`, rerender: true }),
                        rowTools(jPath, i, q.joins.length, 'join')),
                    this.source(join.source, joinPath(jPath, 'source'), ctx, `JOIN ${i + 1}`),
                    join.type === 'CROSS JOIN'
                        ? h('p', { class: 'field-hint' }, 'CROSS JOIN pairs every row with every row of the other table; it has no ON condition.')
                        : h('div', { class: 'join-on' },
                            h('p', { class: 'subquery-label' }, 'ON'),
                            // Filled by the app from the schema: suggested ON conditions
                            join.source.kind === 'table' ? h('div', { class: 'join-hint', hidden: true, dataset: { joinHint: jPath } }) : null,
                            this.group(join.on, joinPath(jPath, 'on'), ctx, { clause: 'ON', root: true, defaultValueType: 'column' }))
                );
            })),
            addBar(button('+ Join', 'add-item', joinPath(path, 'joins'), { arg: 'join' }))
        ];
    }

    grouping(q, path, ctx) {
        return [
            h('h4', { class: 'sub-heading' }, 'GROUP BY'),
            h('ol', { class: 'item-list' }, q.groupBy.map((g, i) => {
                const gPath = joinPath(path, 'groupBy', i);
                return h('li', { class: 'row', dataset: { path: gPath } },
                    textInput(joinPath(gPath, 'expr'), g.expr, { label: `GROUP BY column ${i + 1}`, hidden: true, placeholder: 'column or expression', className: 'grow' }),
                    rowTools(gPath, i, q.groupBy.length, 'GROUP BY column'));
            })),
            addBar(button('+ GROUP BY column', 'add-item', joinPath(path, 'groupBy'), { arg: 'groupBy' })),
            h('h4', { class: 'sub-heading' }, 'HAVING (filter groups)'),
            this.group(q.having, joinPath(path, 'having'), ctx, { clause: 'HAVING', root: true })
        ];
    }

    sorting(q, path) {
        return [
            h('ol', { class: 'item-list' }, q.orderBy.map((o, i) => {
                const oPath = joinPath(path, 'orderBy', i);
                return h('li', { class: 'row', dataset: { path: oPath } },
                    textInput(joinPath(oPath, 'expr'), o.expr, { label: `Sort column ${i + 1}`, hidden: true, placeholder: 'column, alias or expression', className: 'grow' }),
                    select(joinPath(oPath, 'direction'), o.direction, [['ASC', 'Ascending'], ['DESC', 'Descending']], { label: `Sort ${i + 1} direction`, className: 'select-narrow' }),
                    rowTools(oPath, i, q.orderBy.length, 'sort'));
            })),
            addBar(button('+ ORDER BY', 'add-item', joinPath(path, 'orderBy'), { arg: 'orderBy' })),
            h('div', { class: 'field-row' },
                field(joinPath(path, 'limit'), q.limit, { label: this.dialect.ui.limitLabel, placeholder: 'e.g. 10', numeric: true, hint: this.dialect.ui.limitHint || undefined }),
                field(joinPath(path, 'offset'), q.offset, { label: 'OFFSET', placeholder: 'e.g. 20', numeric: true })
            )
        ];
    }

    setOps(q, path, ctx) {
        return [
            h('ol', { class: 'item-list' }, q.setOps.map((setOp, i) => {
                const sPath = joinPath(path, 'setOps', i);
                return h('li', { class: 'card', dataset: { path: sPath } },
                    h('div', { class: 'card-header' },
                        select(joinPath(sPath, 'op'), setOp.op, SET_OPERATORS.map(o => [o, this.option(SET_OPERATOR_LABELS[o], this.dialect.supports.setOperators.includes(o))]), { label: `Set operation ${i + 1}` }),
                        rowTools(sPath, i, q.setOps.length, 'UNION query')),
                    this.select(setOp.query, joinPath(sPath, 'query'), { depth: ctx.depth + 1, top: false, branch: true })
                );
            })),
            addBar(button('+ Combined query', 'add-item', joinPath(path, 'setOps'), { arg: 'setOp', variant: 'ghost' }))
        ];
    }

    // -------------------------------------------------------------- conditions

    group(group, path, ctx, { clause, root = false, defaultValueType = 'value' }) {
        const items = group.items;
        const valueArg = defaultValueType === 'column' ? 'columnCondition' : 'condition';
        return h('div', { class: `cond-group${root ? ' root' : ''}`, dataset: { path } },
            items.length > 1 || !root || group.negate ? h('div', { class: 'cond-group-header row' },
                h('span', {}, 'Match'),
                select(joinPath(path, 'logic'), group.logic, [['AND', 'ALL (AND)'], ['OR', 'ANY (OR)']], { label: `${clause} group logic`, rerender: true, className: 'select-narrow' }),
                h('span', {}, 'of these'),
                checkbox(joinPath(path, 'negate'), group.negate, 'NOT'),
                root ? null : button('', 'remove-item', path, { icon: '✕', label: 'Remove group', variant: 'danger-ghost' })
            ) : null,
            items.length === 0
                ? h('p', { class: 'empty-hint' }, clause === 'WHERE' || clause === 'HAVING' ? `No ${clause} conditions.` : 'No conditions yet.')
                : h('ol', { class: 'item-list cond-list' }, items.map((item, i) => {
                    const iPath = joinPath(path, 'items', i);
                    const logicLabel = i === 0 ? null : h('span', { class: 'logic-label', 'aria-hidden': 'true' }, group.logic);
                    if (item.kind === 'group') {
                        return h('li', { class: 'cond-item' }, logicLabel, this.group(item, iPath, ctx, { clause, defaultValueType }));
                    }
                    if (item.kind === 'raw') {
                        return h('li', { class: 'cond-item' }, logicLabel, h('div', { class: 'row', dataset: { path: iPath } },
                            h('span', { class: 'keyword' }, 'SQL'),
                            textInput(joinPath(iPath, 'sql'), item.sql, { label: `${clause} custom condition ${i + 1}`, hidden: true, placeholder: "custom condition, e.g. LOWER(email) LIKE '%@example.com'", className: 'grow' }),
                            button('', 'remove-item', iPath, { icon: '✕', label: `Remove condition ${i + 1}`, variant: 'danger-ghost' })));
                    }
                    return h('li', { class: 'cond-item' }, logicLabel, this.condition(item, iPath, ctx, clause, i));
                })),
            addBar(
                button('+ Condition', 'add-item', joinPath(path, 'items'), { arg: valueArg }),
                button('+ Group', 'add-item', joinPath(path, 'items'), { arg: 'group', label: 'Add a nested group of conditions (parentheses)' }),
                button('+ Custom SQL', 'add-item', joinPath(path, 'items'), { arg: 'raw' })
            )
        );
    }

    condition(c, path, ctx, clause, index) {
        const spec = OPERATORS[c.op] || OPERATORS['='];
        const n = `${clause} condition ${index + 1}`;
        const canNest = ctx.depth < MAX_NESTING_DEPTH;
        const valueTypes = [
            ['value', 'Value'],
            ['column', 'Column / expression'],
            spec.operands === 1 || spec.operands === 2 ? ['param', 'Parameter'] : null,
            spec.subquery ? ['subquery', 'Subquery', !canNest && c.valueType !== 'subquery'] : null
        ].filter(Boolean);

        const parts = [];
        if (!spec.noLeft) {
            parts.push(textInput(joinPath(path, 'left'), c.left, { label: `${n} column`, hidden: true, placeholder: 'column or expression', className: 'grow' }));
        }
        parts.push(select(joinPath(path, 'op'), c.op, Object.keys(OPERATORS).map(op => [op, op]), { label: `${n} operator`, rerender: true, className: 'select-op' }));

        const showsValues = !spec.subqueryOnly && (spec.operands !== 0 || c.valueType === 'subquery');
        if (spec.subquery || spec.operands !== 0) {
            if (!spec.subqueryOnly) {
                parts.push(select(joinPath(path, 'valueType'), c.valueType, valueTypes, { label: `${n} value type`, rerender: true, className: 'select-narrow' }));
            }
        }
        if (c.valueType !== 'subquery' && showsValues) {
            const isParam = c.valueType === 'param';
            const placeholder = isParam ? PARAM_PLACEHOLDER : c.valueType === 'column' ? 'column or expression' : 'value';
            if (spec.operands === 1) {
                parts.push(textInput(joinPath(path, 'value'), c.value, { label: `${n} ${isParam ? 'parameter name' : 'value'}`, hidden: true, placeholder, className: 'grow' }));
            } else if (spec.operands === 2) {
                parts.push(
                    textInput(joinPath(path, 'value'), c.value, { label: `${n} lower bound${isParam ? ' parameter name' : ''}`, hidden: true, placeholder: isParam ? PARAM_PLACEHOLDER : 'from', className: 'grow' }),
                    h('span', { class: 'keyword' }, 'AND'),
                    textInput(joinPath(path, 'value2'), c.value2, { label: `${n} upper bound${isParam ? ' parameter name' : ''}`, hidden: true, placeholder: isParam ? PARAM_PLACEHOLDER : 'to', className: 'grow' })
                );
            } else if (spec.operands === 'list') {
                parts.push(textInput(joinPath(path, 'value'), c.value, { label: `${n} values`, hidden: true, placeholder: c.valueType === 'column' ? '(a, b) or expression' : 'a, b, c', className: 'grow' }));
            }
        }
        parts.push(button('', 'remove-item', path, { icon: '✕', label: `Remove ${n}`, variant: 'danger-ghost' }));

        const needsSubquery = c.valueType === 'subquery' || spec.subqueryOnly;
        return h('div', { class: 'condition', dataset: { path } },
            h('div', { class: 'row' }, parts),
            needsSubquery && c.subquery ? h('div', { class: 'subquery' },
                h('p', { class: 'subquery-label' }, `Subquery (${c.op})`),
                this.select(c.subquery, joinPath(path, 'subquery'), { depth: ctx.depth + 1, top: false, branch: false })) : null
        );
    }

    // ------------------------------------------------------ INSERT / UPDATE / DELETE

    insert(q, path) {
        const fromSelect = q.source === 'select';
        return h('div', { class: 'dml-editor', dataset: { path } },
            field(joinPath(path, 'table'), q.table, { label: 'Table', placeholder: 'e.g. employees', required: true }),
            field(joinPath(path, 'columns'), q.columns, { label: 'Columns', placeholder: 'e.g. name, department, salary', hint: 'Comma-separated. Optional, but recommended.' }),
            h('div', { class: 'row' },
                h('label', { class: 'field-label', for: fieldId(joinPath(path, 'source')) }, 'Rows from'),
                select(joinPath(path, 'source'), q.source, [['values', 'Values I type (VALUES)'], ['select', 'A query (INSERT … SELECT)']], { rerender: true })
            ),
            fromSelect
                ? h('fieldset', { class: 'fieldset' },
                    h('legend', {}, 'SELECT'),
                    h('p', { class: 'field-hint' }, 'Its columns are inserted in order into the columns listed above.'),
                    this.select(q.select, joinPath(path, 'select'), { depth: 1, top: false, branch: false }))
                : h('fieldset', { class: 'fieldset' },
                    h('legend', {}, 'Rows'),
                    h('p', { class: 'field-hint' }, "Values are SQL: write text in single quotes, e.g. 'Ada', 95000, NULL."),
                    h('ol', { class: 'item-list' }, q.rows.map((row, i) => {
                        const rPath = joinPath(path, 'rows', i);
                        return h('li', { class: 'row', dataset: { path: rPath } },
                            h('span', { class: 'keyword' }, `Row ${i + 1}`),
                            textInput(joinPath(rPath, 'values'), row.values, { label: `Values for row ${i + 1}`, hidden: true, placeholder: "'Ada', 'Engineering', 95000", className: 'grow' }),
                            q.rows.length > 1 ? rowTools(rPath, i, q.rows.length, 'row') : null);
                    })),
                    addBar(button('+ Row', 'add-item', joinPath(path, 'rows'), { arg: 'row' }))
                ),
            this.upsert(q.upsert, joinPath(path, 'upsert'))
        );
    }

    // ON CONFLICT (PostgreSQL) / ON DUPLICATE KEY UPDATE (MySQL)
    upsert(u, path) {
        const modePath = joinPath(path, 'mode');
        const variant = this.dialect.supports.upsert;
        // Only shown where the dialect can write it, or when the query already
        // uses it (then Checks explains why it can't be generated)
        if (!variant && !u.mode) {
            return h('p', { class: 'dialect-note', dataset: { path } },
                `Conflict handling (upsert) is available for PostgreSQL and MySQL, not ${this.dialect.shortLabel}.`);
        }
        return h('fieldset', { class: 'fieldset', dataset: { path } },
            h('legend', {}, 'On conflict (upsert)'),
            h('div', { class: 'row' },
                h('label', { class: 'field-label', for: fieldId(modePath) }, 'When a row already exists'),
                select(modePath, u.mode, [
                    ['', 'Fail (default)'],
                    ['nothing', this.option('Skip the row (DO NOTHING)', variant !== 'on-duplicate-key')],
                    ['update', 'Update the existing row']
                ], { rerender: true })
            ),
            u.mode ? field(joinPath(path, 'conflict'), u.conflict, {
                label: 'Conflict columns', placeholder: 'e.g. email',
                hint: variant === 'on-duplicate-key'
                    ? 'MySQL checks every unique key, so these columns are not written into the SQL.'
                    : 'The unique key that detects an existing row, e.g. email.'
            }) : null,
            u.mode === 'update' ? [
                // h3: the INSERT editor has no section heading above it
                h('h3', { class: 'sub-heading' }, 'Update'),
                h('ol', { class: 'item-list' }, u.set.map((a, i) => {
                    const aPath = joinPath(path, 'set', i);
                    return h('li', { class: 'row', dataset: { path: aPath } },
                        textInput(joinPath(aPath, 'column'), a.column, { label: `Conflict update column ${i + 1}`, hidden: true, placeholder: 'column', className: 'grow' }),
                        h('span', { class: 'keyword' }, '='),
                        select(joinPath(aPath, 'valueType'), a.valueType, [['inserted', 'Inserted value'], ...ASSIGNMENT_TYPES],
                            { label: `Conflict update ${i + 1} value type`, rerender: true, className: 'select-narrow' }),
                        a.valueType === 'inserted' ? null : textInput(joinPath(aPath, 'value'), a.value, {
                            label: `Conflict update ${i + 1} new value`, hidden: true, className: 'grow',
                            placeholder: a.valueType === 'param' ? PARAM_PLACEHOLDER : 'new value'
                        }),
                        rowTools(aPath, i, u.set.length, 'conflict update'));
                })),
                addBar(
                    button('+ Column', 'add-item', joinPath(path, 'set'), { arg: 'upsertAssignment' }),
                    button('Update all inserted columns', 'fill-upsert', path)
                )
            ] : null
        );
    }

    update(q, path) {
        return h('div', { class: 'dml-editor', dataset: { path } },
            field(joinPath(path, 'table'), q.table, { label: 'Table', placeholder: 'e.g. employees', required: true }),
            h('fieldset', { class: 'fieldset', dataset: { path: joinPath(path, 'set') } },
                h('legend', {}, 'SET'),
                h('ol', { class: 'item-list' }, q.set.map((a, i) => {
                    const aPath = joinPath(path, 'set', i);
                    return h('li', { class: 'row', dataset: { path: aPath } },
                        textInput(joinPath(aPath, 'column'), a.column, { label: `SET column ${i + 1}`, hidden: true, placeholder: 'column', className: 'grow' }),
                        h('span', { class: 'keyword' }, '='),
                        select(joinPath(aPath, 'valueType'), a.valueType, ASSIGNMENT_TYPES, { label: `SET ${i + 1} value type`, rerender: true, className: 'select-narrow' }),
                        textInput(joinPath(aPath, 'value'), a.value, { label: `SET ${i + 1} new value`, hidden: true, placeholder: a.valueType === 'param' ? PARAM_PLACEHOLDER : 'new value', className: 'grow' }),
                        rowTools(aPath, i, q.set.length, 'assignment'));
                })),
                addBar(button('+ Column', 'add-item', joinPath(path, 'set'), { arg: 'assignment' }))
            ),
            this.dmlWhere(q, path, 'UPDATE')
        );
    }

    delete(q, path) {
        return h('div', { class: 'dml-editor', dataset: { path } },
            field(joinPath(path, 'table'), q.table, { label: 'Table', placeholder: 'e.g. audit_log', required: true }),
            this.dmlWhere(q, path, 'DELETE')
        );
    }

    dmlWhere(q, path, verb) {
        const empty = q.where.items.length === 0;
        return h('fieldset', { class: 'fieldset' },
            h('legend', {}, 'WHERE'),
            empty ? h('p', { class: 'callout callout-warning', role: 'note' },
                h('strong', {}, 'No WHERE clause: '),
                verb === 'DELETE' ? 'this DELETE will remove every row.' : 'this UPDATE will change every row.') : null,
            this.group(q.where, joinPath(path, 'where'), { depth: 0 }, { clause: 'WHERE', root: true })
        );
    }
}
