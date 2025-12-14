# Module scopes

Use these notes to keep AI review suggestions aligned to the material covered in each module. Paths are under `tasks-js-3/`.

## 01-intro

Paths: `01-intro/*`
Tasks: `1-sum`
Scope: repository setup and first JS steps; simple arithmetic and syntax. Avoid DOM, classes, async patterns, or new dependencies.

## 02-javascript-data-types

**Paths:** `02-javascript-data-types/*`
**Tasks:** `1-sort-strings`, `2-pick`, `3-omit`
**Topics:**

- **Primitives & Methods:** Wrapper objects, `null` vs `undefined`, `toString` vs `valueOf`.
- **Numbers:** Floating point precision (IEEE-754), `isNaN`/`isFinite`, `parseInt`/`parseFloat`, `toFixed`, `Math` object.
- **Strings:** Template literals (backticks), `slice`/`substring`, `indexOf`/`includes`, `localeCompare` (Crucial for Task 1).
- **Objects:** Property access (dot vs brackets), computed properties, `in` operator, `for..in` loop, Reference copy vs value copy.
- **Object Iteration:** `Object.keys`, `Object.values`, `Object.entries`, `Object.fromEntries` (Crucial for Task 2 & 3)[cite: 1963, 2008].
- **Arrays:** `push/pop/shift/unshift`, `splice`, `slice`, `concat`, `forEach`, `indexOf`, `find/filter`, `map`, `sort`, `reverse`, `split/join`, `reduce`.

**Constraints:** NO `class`, NO `prototype`, NO `DOM`, NO `async/await`, NO `Map/Set` (unless explicitly allowed).

### RULES

- **Immutability:** All functions (`sortStrings`, `pick`, `omit`) MUST return a **new** array/object. Mutation of arguments is a critical error.
- **Strings:** Sorting MUST use `.localeCompare()` with specific options. Comparison operators (`> <`) are forbidden for text sorting.
- **Objects:** Prefer `Object.entries()` or `Object.keys()` for iteration.
  - `for..in` is acceptable but less preferred (iterates prototype chain).
  - `delete` is discouraged for performance reasons (V8 de-optimization); constructing a new object is preferred.
- **Modern JS:** Use `const` by default, `let` only when necessary. No `var`. Use arrow functions where appropriate.

### FEW_SHOT_EXAMPLES

- **Task: 1-sort-strings**

  - `arr.sort(...)` (Mutation) -> "Critical: `.sort()` mutates the array in place. Create a copy first: `[...arr].sort(...)`."
  - `(a, b) => a - b` (String math) -> "Bug: You cannot subtract strings. Use `localeCompare`."
  - `localeCompare(b)` (Missing args) -> "Requirement: The task requires supporting 'ru' and 'en' locales and uppercase priority. Use: `a.localeCompare(b, ['ru', 'en'], { caseFirst: 'upper' })`."
  - `if (param === 'asc')` (Repetition) -> "Refactor: Avoid duplicating the sort logic. Define a `directions` object `{ asc: 1, desc: -1 }` and multiply the result of `localeCompare`."

- **Task: 2-pick**

  - `for (let key in obj)` -> "Clean Code: `for..in` iterates over inherited properties. Prefer `Object.entries(obj)` or `Object.keys(obj)`."
  - `if (obj.hasOwnProperty(key))` -> "Modernize: If using `for..in`, this check is good, but `Object.keys()` handles this automatically."
  - `result[key] = obj[key]` (Dynamic access) -> "Good: Correct use of bracket notation for dynamic keys."

- **Task: 3-omit**
  - `const copy = {...obj}; delete copy[key];` -> "Performance: `delete` can be slow. It is better to filter keys and create a new object: `Object.fromEntries(Object.entries(obj).filter(...))`."
  - `!fields.includes(key)` -> "Logic: Correct. For `omit`, we keep keys that are NOT in the forbidden list."
  - `return obj` (Ref Return) -> "Critical: You returned the original object. You must return a new object (shallow copy)."

## 03-objects-arrays-intro-to-testing

**Paths:** `03-objects-arrays-intro-to-testing/*`
**Tasks:** `1-create-getter`, `2-invert-object`, `3-trim-symbols`, `4-uniq`
**Topics:**

- **Data Structures:** `Map`, `Set` (Crucial for `uniq`), `WeakMap/WeakSet`.
- **Objects:** Destructuring assignment (objects/arrays), `Object.entries/keys/values`.
- **Functions:** Closures (Crucial for `createGetter`), Arrow functions (`this` behavior), Recursion (Stack depth, base case),.
- **OOP Basics:** Constructors with `new`, `this` context (implicit/explicit binding),.
- **Testing:** Unit testing concepts (Jest/Mocha), Test-Driven Development (TDD) flow.

**Constraints:**

- **Environment:** NO DOM access (`document`, `window`, `alert`), NO browser-only APIs (`localStorage`, `fetch`). Pure Node.js logic only.
- **Task 3 (trimSymbols):** Strict Ban on Regular Expressions. Must use loop or accumulation.
- **Task 4 (uniq):** Must use `new Set()` for O(N) complexity. `filter` + `indexOf` is forbidden (O(N²)).

### RULES

- **Closures:** `createGetter` must return a function that "remembers" the path. Do not re-parse the path on every call.
- **Efficiency:** For unique values (`uniq`), strict O(N) complexity via `Set` is required. O(N²) methods (like `filter` + `indexOf`) are unacceptable.
- **Object Transformation:** For `invertObj`, prefer `Object.entries()` coupled with `reduce` or `Object.fromEntries`.
- **Testing:** Code must handle edge cases like `undefined` or empty inputs as shown in the tests (e.g., `invertObj(undefined)` should return `undefined`).

### FEW_SHOT_EXAMPLES

- **Task: 1-create-getter**

  - `function(obj) { ... }` (Inside getter) -> "Style: Use arrow function `obj => { ... }` to preserve context and conciseness."
  - `path.split('.')` (Inside returned function) -> "Performance: Move `path.split('.')` **outside** the returned function. The path should be parsed once (Closure), not every time the getter is called."
  - `eval(...)` -> "Critical: Never use `eval`. Iterate over the properties using a loop or reduce."

- **Task: 2-invert-object**

  - `for (let key in obj)` -> "Modernize: Use `Object.entries(obj).forEach` or `.reduce` to iterate keys and values simultaneously."
  - `if (obj === undefined) return` -> "Good: Correct handling of missing arguments."
  - `newObj[obj[key]] = key` -> "Logic: Correct logic for swapping key/value."

- **Task: 3-trim-symbols**

  - `string.replace(/.../g)` -> "Constraint Violation: Regular Expressions are forbidden for this task. Use a loop or accumulation strategy."
  - `if (count < size)` -> "Logic: Good tracking of consecutive character counts."

- **Task: 4-uniq**
  - `arr.filter((v, i) => arr.indexOf(v) === i)` -> "Performance: This approach is O(N²). Use `[...new Set(arr)]` for O(N) complexity."
  - `arr.reduce(...)` (For uniqueness) -> "Refactor: Using `Set` is the idiomatic and most efficient way to dedup arrays in modern JS."
  - `Array.from(new Set(arr))` -> "Style: `[...new Set(arr)]` is slightly more concise, but `Array.from` is also acceptable."

## 04-oop-basic-intro-to-dom

**Paths:** `04-oop-basic-intro-to-dom/*`
**Tasks:** `1-column-chart`
**Topics:**

- **Classes:** Syntax (`class`), Inheritance (`extend`), Constructors, Protected/Public/Private Fields, Methods, Getters/Setters, Prototype Chains, Staitc Members, advanced `this`
- **DOM Tree:** `document.body`, `querySelector`, `closest`, `innerHTML` vs `createElement`, `dataset` attributes.
- **Styles:** `classList` (`add`, `remove`, `toggle`), changing CSS variables or inline styles.
- **DOM Navigation:** `document.body`, `firstElementChild`, `children`, `closest`.
- **DOM Modification:** `createElement`, `innerHTML`, `append`, `remove`.
- **Advanced Functions:** `call/apply`, `bind`, Arrow functions (context), Default parameters.
- **Concepts:** Component Lifecycle (constructor -> render -> update -> destroy), "SubElements" pattern.
- **Timers:** `setTimeout`, `setInterval`

**Constraints:**

- **No Fetch:** Data loading logic is NOT required yet (mock data is provided).
- **No External Libs:** No `lodash`, no `axios`. Pure JS classes.
- **DOM Access:** Do NOT query the `document` globally (e.g., `document.querySelector('.chart')`). Components must be self-contained and only query within `this.element`.

### RULES

1.  **Component Architecture:** The class MUST expose a `this.element` property (DOM Node) after `render()` is called.
2.  **Efficient Rendering:** Prefer building a single HTML string (template literal) and setting `innerHTML` once, rather than creating 50 separate nodes with `document.createElement`.
3.  **SubElements Pattern:** Do NOT use `this.element.querySelector(...)` inside the `update()` method. Cache dynamic elements (like the body chart) in `this.subElements` during the initial render.
4.  **Cleanup:** The `destroy()` method must remove the element from the DOM and nullify references to prevent memory leaks.
5.  **Parameters:** The constructor must use object destructuring with default values (e.g., `constructor({ data = [], value = 0 } = {})`).

### FEW_SHOT_EXAMPLES (Russian)

**Task: 1-column-chart**

- **Code:** `this.element = document.querySelector('.column-chart')`
  **Review:** "Ошибка инкапсуляции: Компонент не должен искать себя в `document`. Он должен создавать свой DOM-элемент сам (через `document.createElement`), чтобы быть переиспользуемым."

- **Code:** `update(data) { this.element.innerHTML = this.getTemplate(data); }`
  **Review:** "Производительность: Метод `update` не должен перерисовывать весь компонент (заголовок, ссылку и т.д.). Обновляй только тело чарта (столбики), используя ссылку на контейнер из `this.subElements`."

- **Code:** `constructor(data, label, link)`
  **Review:** "Интерфейс: Согласно тестам, конструктор должен принимать **один объект** с параметрами. Используй деструктуризацию: `constructor({ data = [], label = '', link = '' } = {})`."

- **Code:** `return '<div class="column-chart" ...>' + this.label + '</div>'`
  **Review:** "Стиль: Для HTML-разметки используй шаблонные строки (backticks ``). Это делает код чище и безопаснее."

- **Code:** `destroy() { this.element = null; }`
  **Review:** "Утечка памяти: Метод `destroy` должен сначала удалить элемент из DOM (`this.remove()`), а затем очистить ссылки (`this.element = null`, `this.subElements = {}`)."

- **Code:** `const scale = 50 / maxValue;`
  **Review:** "Хардкод: Число `50` — это высота чарта. Вынеси его в свойство класса `this.chartHeight`, чтобы код был гибким."

- **Code:** `if (data.length === 0) return;` (В render)
  **Review:** "Логика: Даже если данных нет, компонент должен отрендериться в состоянии 'loading' (показать скелетон), а не возвращать `undefined`."

**General DOM**

- **Code:** `div.innerHTML += '<div>...</div>'` (В цикле)
  **Review:** "Производительность: Избегай изменения `innerHTML` в цикле, это вызывает лишние перерисовки (reflow). Собери весь HTML в одну строку и присвой его один раз."

- **Code:** `document.body.append(this.element)` (Внутри класса)
  **Review:** "Архитектура: Компонент не должен сам себя вставлять на страницу. Это делает внешний код (main.js или тесты). Убери побочные эффекты из класса."

## 05-dom-document-loading

**Paths:** `05-dom-document-loading/*`
**Tasks:** `1-notification`, `2-sortable-table-v1`
**Topics:**

- **Modules:** `import`/`export`, `export default`, named exports, module scripts (`<script type="module">`).
- **Events:** `DOMContentLoaded`, resource loading (`async`/`defer`), `setTimeout` (for Notification).
- **Architecture:** "Singleton" pattern (for Notification), separating Header/Body rendering (for Table).

**Constraints:**

- **Framework-free:** Pure Vanilla JS. No React/Vue/Angular concepts.
- **No Global Side Effects:** Components should not attach themselves to `document.body` in the constructor. They must wait for a `.show()` call.
- **DOM Performance:** Avoid loops that append elements to the DOM one by one. Build a big string or use `DocumentFragment`.

### RULES

1.  **Notification Pattern:** The `NotificationMessage` component should act like a "Singleton" regarding the UI. If a new notification is shown while an old one is visible, the old one must be removed first.
2.  **Sorting Logic:** `SortableTable` must correctly handle data types. Strings must be sorted with `.localeCompare(..., ['ru', 'en'], {caseFirst: 'upper'})`, numbers with subtraction.
3.  **SubElements:** Continue enforcing the `subElements` pattern (caching DOM nodes by `data-element`).
4.  **Cleanup:** `destroy()` must clear any active `setTimeout` (timer) to prevent memory leaks or errors after component removal.
5.  **ES Modules:** Ensure `export default` is used where required by the tests/boilerplate.

### FEW_SHOT_EXAMPLES (Russian)

**Task: 1-notification**

- **Code:** `constructor() { ... this.show(); }`
  **Review:** "Побочные эффекты: Конструктор не должен сам показывать уведомление. Метод `show()` должен вызываться извне или отдельно."

- **Code:** `document.body.append(this.element)` (Without checking existing)
  **Review:** "Логика: Перед показом нового уведомления нужно проверить, есть ли уже активное уведомление на странице, и удалить его (реализация Singleton-поведения)."

- **Code:** `setTimeout(() => this.remove(), this.duration);` (Saved nowhere)
  **Review:** "Утечка ресурсов: Сохрани идентификатор таймера (timerId), чтобы очистить его в методе `destroy()`, если компонент будет удален раньше времени."

**Task: 2-sortable-table-v1**

- **Code:** `if (field === 'title') { ... } else if (field === 'price') { ... }`
  **Review:** "Хардкод: Не пиши `if/else` для каждого поля. Используй конфигурацию `headerConfig`, чтобы определить тип сортировки ('string' или 'number') динамически."

- **Code:** `rows.forEach(row => this.subElements.body.append(row))`
  **Review:** "Производительность: Избегай вставки элементов в DOM в цикле (это вызывает лишние перерисовки). Собери HTML всех строк в одну переменную и присвой `innerHTML` один раз."

- **Code:** `sort(field, order) { this.data.sort(...) }`
  **Review:** "Мутация: Метод `sort` не должен менять порядок в исходном массиве `this.data` (если это не требуется явно). Лучше создавать отсортированную копию или держать порядок отдельно."

- **Code:** `(a, b) => a[field] > b[field] ? 1 : -1`
  **Review:** "Сортировка: Прямое сравнение `>` некорректно работает со строками (особенно русскими). Используй `localeCompare` с опцией `{ caseFirst: 'upper' }`."

**General / ES Modules**

- **Code:** `module.exports = class ...`
  **Review:** "Синтаксис: Мы используем ES Modules. Замени на `export default class ...`."

- **Code:** `element.className = 'box'`
  **Review:** "Best Practice: Избегай перезаписи всего `className`. Используй `element.classList.add('box')` для безопасного добавления классов."

## 06-events-practice

Paths: `06-events-practice/*`
Tasks: `1-sortable-table-v2`, `2-tooltip`, `3-double-slider`
Scope: browser events, bubbling/capturing, delegation, default actions, custom events, mouse movement/drag and drop, keyboard handling, scroll, date/time utilities. Avoid fetch/async beyond simple timers.

## 07-async-code-fetch-api-part-1

Paths: `07-async-code-fetch-api-part-1/*`
Tasks: `1-column-chart`, `2-sortable-table-v3`
Scope: promises and chaining, error handling, Promise API, microtasks, async/await, dynamic imports, fetch GET and cross-origin handling, URL objects, event loop behavior. Do not rely on form APIs or routing yet.

## 08-forms-fetch-api-part-2

Paths: `08-forms-fetch-api-part-2/*`
Tasks: `1-product-form-v1`, `2-range-picker`
Scope: FormData, fetch POST/progress/abort/resume, JSON serialization, form elements and events (focus/blur/input/change/submit), timers, scroll handling. Keep dependencies minimal; avoid routing/history work.

## 09-tests-for-frontend-apps

Paths: `09-tests-for-frontend-apps/*`
Tasks: `1-product-form-v2`, `2-sortable-list`
Scope: frontend testing with Jest and helpers (jest-dom, fetch mocks), drag-and-drop interactions, ensuring components stay testable and side-effect free. Avoid introducing new packages unless required for tests.

## 10-routes-browser-history-api

Paths: `10-routes-browser-history-api/*`
Tasks: `1-dashboard-page`
Scope: routing, History API navigation, regular expressions for route matching, event handling for links/navigation. Do not add frameworks; stay within plain JS and existing tooling.

## 11-webpack

Paths: `11-webpack/*`
Tasks: course pages such as Categories, Products, Product edit, Sales
Scope: webpack-based builds with the provided config, Babel transpilation, common loaders/plugins, assembling course pages. Keep to the documented webpack/Babel/eslint stack and avoid replacing the toolchain.
