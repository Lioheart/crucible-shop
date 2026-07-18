import {MODULE_ID, applyPurchase, applySell, requestTransactionApproval, recordTransaction} from "./crucible-shop.mjs";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

/**
 * A standalone shop application. Lets an actor spend their REAL currency to buy items onto their
 * REAL inventory. Purchases are staged into a cart and only applied to the actor when the player
 * confirms - nothing is written to the actor until "Confirm Purchase" is clicked.
 */
export class CrucibleShopApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @param {{actor: Actor, shop: object}} options */
  constructor({actor, shop, ...options}={}) {
    super(options);
    this.actor = actor;
    this.shop = shop;
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "crucible-shop-{id}",
    tag: "div",
    classes: ["crucible", "themed", "theme-dark", "crucible-shop"],
    window: {
      title: "CRUCIBLE_SHOP.ShopTitle",
      icon: "fa-solid fa-coins",
      resizable: true
    },
    position: {
      width: 900,
      height: 700
    },
    actions: {
      addItem: CrucibleShopApp.#onAddItem,
      removeItem: CrucibleShopApp.#onRemoveItem,
      filterType: CrucibleShopApp.#onFilterType,
      filterCategory: CrucibleShopApp.#onFilterCategory,
      filterAffordable: CrucibleShopApp.#onFilterAffordable,
      confirmPurchase: CrucibleShopApp.#onConfirmPurchase,
      clearCart: CrucibleShopApp.#onClearCart,
      switchTab: CrucibleShopApp.#onSwitchTab,
      sellAdd: CrucibleShopApp.#onSellAdd,
      sellRemove: CrucibleShopApp.#onSellRemove,
      clearSellCart: CrucibleShopApp.#onClearSellCart,
      confirmSell: CrucibleShopApp.#onConfirmSell
    }
  };

  /** @override */
  static PARTS = {
    shop: {
      id: "shop",
      template: "modules/crucible-shop/templates/shop.hbs",
      scrollable: [".shop-list", ".shop-cart", ".sell-list", ".sell-cart"]
    }
  };

  /**
   * A SearchFilter instance for filtering the item list.
   * @type {foundry.applications.ux.SearchFilter}
   */
  #search = new foundry.applications.ux.SearchFilter({
    inputSelector: ".shop-search",
    contentSelector: ".shop-list",
    callback: (event, query, rgx, html) => CrucibleShopApp.#onSearchFilter(event, query, rgx, html)
  });

  /**
   * Whether the item catalog has been loaded yet.
   * @type {boolean}
   */
  #initialized = false;

  /**
   * Working state for this shop session.
   * @type {{
   *   items: {item: Item, price: number}[],
   *   categoriesByType: Record<string, Record<string, string>>,
   *   cart: Record<string, {item: Item, price: number, quantity: number}>,
   *   filter: {type: string|null, category: string|null, affordableOnly: boolean},
   *   activeTab: "buy"|"sell",
   *   sellCart: Record<string, {item: Item, unitPrice: number, quantity: number}>,
   *   pendingRequest: {id: string, kind: "buy"|"sell"}|null
   * }}
   */
  _state = {items: [], categoriesByType: {}, cart: {}, filter: {type: null, category: null, affordableOnly: false},
    activeTab: "buy", sellCart: {}, pendingRequest: null};

  /* -------------------------------------------- */

  /** @override */
  get title() {
    return game.i18n.format("CRUCIBLE_SHOP.ShopTitle", {name: this.shop.name});
  }

  /* -------------------------------------------- */
  /*  Catalog Initialization                       */
  /* -------------------------------------------- */

  /**
   * Load the shop's stock, either from the system's default Equipment compendium tree or from the
   * shop's own curated list of item UUIDs.
   * @returns {Promise<void>}
   */
  async #initializeCatalog() {
    const items = (this.shop.mode === "custom")
      ? await this.#loadCustomItems()
      : await this.#loadDefaultItems();
    const buyRate = this.shop.buyRate ?? 100;
    for ( const entry of items ) entry.price = CrucibleShopApp.applyRate(entry.price, buyRate);
    items.sort((a, b) => a.item.name.localeCompare(b.item.name));
    this._state.items = items;

    const categoriesByType = {};
    for ( const {item} of items ) {
      const type = item.type;
      const catId = item.system.category;
      if ( !catId ) continue;
      categoriesByType[type] ??= {};
      categoriesByType[type][catId] ??= item.system.config?.category?.label ?? catId;
    }
    this._state.categoriesByType = categoriesByType;
    this.#initialized = true;
  }

  /* -------------------------------------------- */

  /**
 * Load items from the system's configured Equipment compendium packs.
 * @returns {Promise<{item: Item, price: number}[]>}
 */
  async #loadDefaultItems() {
    const items = [];
    console.log(`${MODULE_ID} | Equipment packs:`, [...crucible.CONFIG.packs.equipment]);
    for (const packId of crucible.CONFIG.packs.equipment) {
      const pack = game.packs.get(packId);
      if (!pack) {
        console.warn(`${MODULE_ID} | Missing compendium: ${packId}`);
        continue;
      }
      console.log(`${MODULE_ID} | Loading ${pack.collection}`);
      const docs = await pack.getDocuments();
      console.log(`${MODULE_ID} | ${docs.length} items loaded from ${pack.collection}`);
      for (const item of docs) {
        if (!item.system.price) continue;
        if (item.type === "consumable" && item.system.category === "scroll") continue;
        items.push({
          item,
          price: item.system.price
        });
      }
    }
    console.log(`${MODULE_ID} | Total shop items: ${items.length}`);
    return items;
  }

  /* -------------------------------------------- */

  /**
   * Load items from this shop's curated UUID list.
   * @returns {Promise<{item: Item, price: number}[]>}
   */
  async #loadCustomItems() {
    const items = [];
    const priceOverrides = this.shop.itemPrices ?? {};
    for ( const uuid of this.shop.itemUuids ?? [] ) {
      const item = await fromUuid(uuid);
      if ( !item ) continue;
      // A price set by the GM in the Shop Manager always wins - this is how items with no price
      // of their own (custom/homebrew items, or ones just missing a price) can still be sold.
      const price = priceOverrides[uuid] ?? item.system?.price ?? 0;
      items.push({item, price});
    }
    return items;
  }

  /* -------------------------------------------- */
  /*  Rendering                                    */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(_options) {
    // Must happen here, not in _preFirstRender: ApplicationV2 calls _prepareContext BEFORE
    // _preFirstRender, so loading the catalog there was always one render too late - the first
    // paint would build its context from an empty item list, and only a subsequent render (e.g.
    // clicking a filter) would pick up the loaded items.
    if ( !this.#initialized ) await this.#initializeCatalog();

    const currency = this.actor.system.currency ?? 0;
    const cart = this._state.cart;
    const {type: filterType, category: filterCategory, affordableOnly} = this._state.filter;
    const buyRate = this.shop.buyRate ?? 100;

    let cartSpent = 0;
    for ( const {price, quantity} of Object.values(cart) ) cartSpent += price * quantity;
    const remaining = currency - cartSpent;

    // Type filter options
    const seenTypes = new Map();
    for ( const {item} of this._state.items ) {
      if ( !seenTypes.has(item.type) ) {
        seenTypes.set(item.type, game.i18n.localize(`TYPES.Item.${item.type}`) || item.type);
      }
    }
    const filterTypes = [...seenTypes.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, label]) => ({id, label, active: filterType === id}));

    // Category filter options for the selected type
    let filterCategories = null;
    if ( filterType && this._state.categoriesByType[filterType] ) {
      filterCategories = Object.entries(this._state.categoriesByType[filterType])
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, label]) => ({id, label, active: filterCategory === id}));
    }

    // Apply filters
    let sourceItems = this._state.items;
    if ( filterType ) sourceItems = sourceItems.filter(e => e.item.type === filterType);
    if ( filterCategory ) sourceItems = sourceItems.filter(e => e.item.system.category === filterCategory);
    if ( affordableOnly ) {
      sourceItems = sourceItems.filter(({item, price}) => (price <= remaining) || (item.uuid in cart));
    }

    const shopItems = sourceItems.map(({item, price}) => {
      let tags = {};
      try { tags = item.system.getTags?.() ?? {}; } catch(err) { tags = {}; }
      tags = Object.fromEntries(
        Object.entries(tags)
          .filter(([, v]) => v != null && v !== "")
          .map(([k, v]) => [k, (typeof v === "string") ? {label: v} : v])
      );
      if ( (item.type === "weapon") && item.system._getUntrainedTooltip ) {
        const untrainedTooltip = item.system._getUntrainedTooltip(this.actor);
        if ( untrainedTooltip && tags.category ) {
          tags.category = {...tags.category, unmet: true, tooltip: untrainedTooltip};
        }
      }

      return {
        uuid: item.uuid,
        name: item.name,
        img: item.img,
        tags: Object.values(tags),
        price,
        quantity: cart[item.uuid]?.quantity ?? 0,
        unaffordable: (price > remaining) && !(item.uuid in cart)
      };
    });

    const cartItems = Object.values(cart).map(({item, price, quantity}) => ({
      uuid: item.uuid,
      name: item.name,
      img: item.img,
      quantity,
      price,
      totalCost: price * quantity,
      unaffordable: price > remaining
    }));

    const sellRate = this.shop.sellRate ?? 100;
    const sellCart = this._state.sellCart;
    const sellItems = this.#getSellableItems().map(item => {
      const unitPrice = CrucibleShopApp.applyRate(item.system.price ?? 0, sellRate);
      const owned = item.system.quantity ?? 1;
      const staged = sellCart[item.id]?.quantity ?? 0;
      return {
        id: item.id,
        name: item.name,
        img: item.img,
        unitPrice,
        owned,
        staged,
        maxed: staged >= owned
      };
    });

    let sellEarned = 0;
    for ( const {unitPrice, quantity} of Object.values(sellCart) ) sellEarned += unitPrice * quantity;
    const sellCartItems = Object.values(sellCart).map(({item, unitPrice, quantity}) => ({
      id: item.id,
      name: item.name,
      img: item.img,
      quantity,
      unitPrice,
      totalValue: unitPrice * quantity
    }));

    return {
      shop: this.shop,
      actor: this.actor,
      isGM: game.user.isGM,
      currency,
      remaining,
      filterTypes,
      filterType,
      filterCategories,
      filterCategory,
      filterAffordable: affordableOnly,
      shopItems,
      cartItems,
      cartEmpty: !cartItems.length,
      noItems: !this._state.items.length,
      noAffordableItems: affordableOnly && !shopItems.length && !!this._state.items.length,
      activeTab: this._state.activeTab,
      buyTabActive: this._state.activeTab === "buy",
      sellTabActive: this._state.activeTab === "sell",
      buyRate,
      sellRate,
      sellItems,
      noSellItems: !sellItems.length,
      sellCartItems,
      sellCartEmpty: !sellCartItems.length,
      sellEarned,
      sellEarnedFormatted: CrucibleShopApp.formatCurrency(sellEarned),
      pendingRequest: this._state.pendingRequest
    };
  }

  /* -------------------------------------------- */

  /**
   * The actor's own inventory items that this shop will buy - anything with a price greater
   * than zero. This intentionally does not distinguish where the item came from (bought here,
   * looted, homebrewed, etc.) - if it has a price, it can be sold.
   * @returns {Item[]}
   */
  #getSellableItems() {
    return this.actor.items.filter(item => (item.system?.price ?? 0) > 0);
  }

  /* -------------------------------------------- */

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#search.bind(this.element);
    if ( game.user.isGM ) {
      const currencyInput = this.element.querySelector(".shop-currency .total");
      currencyInput?.addEventListener("change", this.#onChangeCurrency.bind(this));
    }
  }

  /* -------------------------------------------- */

  /** @override */
  _tearDown(options) {
    this.#search.unbind();
    super._tearDown(options);
  }

  /* -------------------------------------------- */

  /**
   * Scale a base price by a shop's rate - a plain percentage of the item's listed value, e.g. 80
   * for "80% of value" or 120 for "120% of value". Used for both buy prices and sell payouts,
   * each shop having its own independent buyRate and sellRate.
   * @param {number} basePrice
   * @param {number} rate   A percentage of value, e.g. 100 for full price.
   * @returns {number}
   */
  static applyRate(basePrice, rate) {
    return Math.max(0, Math.round(basePrice * (rate / 100)));
  }

  /* -------------------------------------------- */

  /**
   * Format a raw base-unit currency amount as a human-readable denomination string, e.g. "3gp 5sp".
   * @param {number} amount
   * @returns {string}
   */
  static formatCurrency(amount) {
    const allocated = crucible.api.documents.CrucibleActor.allocateCurrency(amount);
    const parts = [];
    for ( const [k, v] of Object.entries(allocated) ) {
      if ( !v ) continue;
      const abbreviation = game.i18n.localize(crucible.CONFIG.currency[k]?.abbreviation ?? k);
      parts.push(`${v}${abbreviation}`);
    }
    return parts.length ? parts.join(" ") : `0${game.i18n.localize(crucible.CONFIG.currency.cp?.abbreviation ?? "cp")}`;
  }

  /* -------------------------------------------- */
  /*  Event Handlers                               */
  /* -------------------------------------------- */

  static #onSearchFilter(_event, query, rgx, html) {
    if ( !html ) return;
    for ( const entry of html.querySelectorAll(".shop-entry") ) {
      const name = foundry.applications.ux.SearchFilter.cleanQuery(entry.dataset.itemName ?? "");
      entry.hidden = !!query && !rgx.test(name);
    }
  }

  /* -------------------------------------------- */

  static async #onFilterType(_event, target) {
    this._state.filter.type = target.dataset.filterType ?? null;
    this._state.filter.category = null;
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  static async #onFilterCategory(_event, target) {
    this._state.filter.category = target.dataset.filterCategory ?? null;
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  static async #onFilterAffordable() {
    this._state.filter.affordableOnly = !this._state.filter.affordableOnly;
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  static async #onAddItem(_event, target) {
    const uuid = target.closest("[data-uuid]").dataset.uuid;
    const found = this._state.items.find(e => e.item.uuid === uuid);
    if ( !found ) return;
    const {item, price} = found;
    const cart = this._state.cart;

    let spent = 0;
    for ( const {price: p, quantity} of Object.values(cart) ) spent += p * quantity;
    const remaining = (this.actor.system.currency ?? 0) - spent;
    if ( price > remaining ) {
      ui.notifications.warn(game.i18n.format("CRUCIBLE_SHOP.InsufficientFunds", {name: item.name}));
      return;
    }

    if ( uuid in cart ) cart[uuid].quantity++;
    else cart[uuid] = {item, price, quantity: 1};
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  static async #onRemoveItem(_event, target) {
    const uuid = target.closest("[data-uuid]").dataset.uuid;
    const cart = this._state.cart;
    if ( !(uuid in cart) ) return;
    cart[uuid].quantity--;
    if ( cart[uuid].quantity <= 0 ) delete cart[uuid];
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  static async #onClearCart() {
    this._state.cart = {};
    await this.render({parts: ["shop"]});
  }

  /**
   * GM-only: set the actor's currency directly from the shop window. This is what lets a shop
   * be used on an actor who has no currency set yet, or whose currency needs correcting, without
   * leaving the shop to edit the actor sheet. Always writes the same base-unit integer that
   * formatCurrency()/allocateCurrency() already expect, so it stays denomination-consistent with
   * the rest of the shop rather than a raw, un-denominated number.
   */
  async #onChangeCurrency(event) {
    const raw = Number(event.target.value ?? 0);
    const amount = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
    await this.actor.update({"system.currency": amount});
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  static async #onSwitchTab(_event, target) {
    this._state.activeTab = target.dataset.tab === "sell" ? "sell" : "buy";
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  static async #onSellAdd(_event, target) {
    const id = target.closest("[data-item-id]").dataset.itemId;
    const item = this.actor.items.get(id);
    if ( !item ) return;

    const sellCart = this._state.sellCart;
    const owned = item.system.quantity ?? 1;
    const staged = sellCart[id]?.quantity ?? 0;
    if ( staged >= owned ) return;

    const sellRate = this.shop.sellRate ?? 100;
    const unitPrice = CrucibleShopApp.applyRate(item.system.price ?? 0, sellRate);

    if ( id in sellCart ) sellCart[id].quantity++;
    else sellCart[id] = {item, unitPrice, quantity: 1};
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  static async #onSellRemove(_event, target) {
    const id = target.closest("[data-item-id]").dataset.itemId;
    const sellCart = this._state.sellCart;
    if ( !(id in sellCart) ) return;
    sellCart[id].quantity--;
    if ( sellCart[id].quantity <= 0 ) delete sellCart[id];
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  static async #onClearSellCart() {
    this._state.sellCart = {};
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  /**
   * Apply the sell cart to the actor: pay out currency and remove/decrement the sold items.
   * If this shop is a "custom" shop, the sold items are also restocked into the shop's own item
   * list so other players can buy them back. GMs can restock immediately since they're allowed to
   * write the world-scoped shop setting directly; non-GM sellers cannot write that setting, so
   * their sale is instead handed off to a GM client via a quiet whispered chat message (the same
   * "no sockets required" pattern the chat invite button already uses) which restocks on arrival.
   */
  static async #onConfirmSell() {
    const staged = Object.values(this._state.sellCart).filter(s => s.quantity > 0);
    if ( !staged.length ) {
      ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.SellNone"));
      return;
    }

    const entries = staged.map(({item, unitPrice, quantity}) => (
      {itemId: item.id, name: item.name, img: item.img, unitPrice, quantity}));
    const earned = entries.reduce((sum, {unitPrice, quantity}) => sum + (unitPrice * quantity), 0);

    if ( this.shop.requireApproval ) {
      const request = await requestTransactionApproval(
        {kind: "sell", shop: this.shop, actor: this.actor, entries, total: earned});
      if ( !request ) return; // No GM online - a warning was already shown.
      this._state.pendingRequest = {id: request.requestId, kind: "sell"};
      await this.render({parts: ["shop"]});
      return;
    }

    const result = await applySell(this.actor, this.shop, entries);
    await recordTransaction({kind: "sell", shop: this.shop, actor: this.actor, entries, result});
    ui.notifications.info(game.i18n.format(
      "CRUCIBLE_SHOP.SellSuccess", {count: result.count, earned: CrucibleShopApp.formatCurrency(result.earned)}));
    this._state.sellCart = {};
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  /**
   * Apply the cart to the actor: deduct currency and create/update items. Nothing about the
   * actor changes until this runs.
   */
  static async #onConfirmPurchase() {
    const cart = Object.values(this._state.cart).filter(c => c.quantity > 0);
    if ( !cart.length ) {
      ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.PurchaseNone"));
      return;
    }

    const entries = cart.map(({item, price, quantity}) => (
      {uuid: item.uuid, name: item.name, img: item.img, price, quantity}));
    const spent = entries.reduce((sum, {price, quantity}) => sum + (price * quantity), 0);
    const currency = this.actor.system.currency ?? 0;
    if ( spent > currency ) {
      ui.notifications.error(game.i18n.localize("CRUCIBLE_SHOP.PurchaseFailed"));
      return;
    }

    if ( this.shop.requireApproval ) {
      const request = await requestTransactionApproval(
        {kind: "buy", shop: this.shop, actor: this.actor, entries, total: spent});
      if ( !request ) return; // No GM online - a warning was already shown.
      this._state.pendingRequest = {id: request.requestId, kind: "buy"};
      await this.render({parts: ["shop"]});
      return;
    }

    const result = await applyPurchase(this.actor, entries);
    if ( result?.failed ) {
      ui.notifications.error(game.i18n.localize("CRUCIBLE_SHOP.PurchaseFailed"));
      return;
    }
    await recordTransaction({kind: "buy", shop: this.shop, actor: this.actor, entries, result});

    ui.notifications.info(game.i18n.format(
      "CRUCIBLE_SHOP.PurchaseSuccess", {count: result.count, spent: CrucibleShopApp.formatCurrency(result.spent)}));
    this._state.cart = {};
    await this.render({parts: ["shop"]});
  }

  /* -------------------------------------------- */

  /**
   * Called when a GM resolves a pending transaction this app is waiting on (approved, denied, or
   * failed at approval time e.g. insufficient funds). Reached via the module's updateChatMessage
   * hook, not called directly by any UI action.
   * @param {object} request   The resolved transactionRequest flag data.
   */
  resolvePendingTransaction(request) {
    this._state.pendingRequest = null;

    if ( request.status === "approved" ) {
      if ( request.kind === "buy" ) {
        this._state.cart = {};
        ui.notifications.info(game.i18n.format("CRUCIBLE_SHOP.PurchaseSuccess",
          {count: request.result?.count ?? 0, spent: CrucibleShopApp.formatCurrency(request.result?.spent ?? 0)}));
      }
      else {
        this._state.sellCart = {};
        ui.notifications.info(game.i18n.format("CRUCIBLE_SHOP.SellSuccess",
          {count: request.result?.count ?? 0, earned: CrucibleShopApp.formatCurrency(request.result?.earned ?? 0)}));
      }
    }
    else if ( request.status === "denied" ) {
      ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.RequestDenied"));
    }
    else {
      ui.notifications.error(game.i18n.localize("CRUCIBLE_SHOP.RequestFailed"));
    }

    this.render({parts: ["shop"]});
  }
}
