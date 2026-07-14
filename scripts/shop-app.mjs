import {MODULE_ID} from "./crucible-shop.mjs";

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
      confirmPurchase: CrucibleShopApp.#onConfirmPurchase,
      clearCart: CrucibleShopApp.#onClearCart
    }
  };

  /** @override */
  static PARTS = {
    shop: {
      id: "shop",
      template: "modules/crucible-shop/templates/shop.hbs",
      scrollable: [".shop-list", ".shop-cart"]
    }
  };

  /**
   * A SearchFilter instance for filtering the item list.
   * @type {foundry.applications.ux.SearchFilter}
   */
  #search = new foundry.applications.ux.SearchFilter({
    inputSelector: ".shop-search",
    contentSelector: ".shop-list",
    callback: (event, query, rgx, html) => this.#onSearchFilter(event, query, rgx, html)
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
   *   filter: {type: string|null, category: string|null}
   * }}
   */
  _state = {items: [], categoriesByType: {}, cart: {}, filter: {type: null, category: null}};

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
    for ( const uuid of this.shop.itemUuids ?? [] ) {
      const item = await fromUuid(uuid);
      if ( !item || !item.system?.price ) continue;
      items.push({item, price: item.system.price});
    }
    return items;
  }

  /* -------------------------------------------- */
  /*  Rendering                                    */
  /* -------------------------------------------- */

  /** @override */
  async _preFirstRender(context, options) {
    await super._preFirstRender(context, options);
    if ( !this.#initialized ) await this.#initializeCatalog();
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(_options) {
    const currency = this.actor.system.currency ?? 0;
    const cart = this._state.cart;
    const {type: filterType, category: filterCategory} = this._state.filter;

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

    const shopItems = sourceItems.map(({item, price}) => {
      let tags = {};
      try { tags = item.system.getTags?.() ?? {}; } catch(err) { tags = {}; }
      if ( (item.type === "weapon") && item.system._getUntrainedTooltip ) {
        const untrainedTooltip = item.system._getUntrainedTooltip(this.actor);
        if ( untrainedTooltip ) tags.category = {label: tags.category, unmet: true, tooltip: untrainedTooltip};
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

    return {
      shop: this.shop,
      actor: this.actor,
      currency,
      remaining,
      filterTypes,
      filterType,
      filterCategories,
      filterCategory,
      shopItems,
      cartItems,
      cartEmpty: !cartItems.length,
      noItems: !this._state.items.length
    };
  }

  /* -------------------------------------------- */

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#search.bind(this.element);
  }

  /* -------------------------------------------- */

  /** @override */
  _tearDown(options) {
    this.#search.unbind();
    super._tearDown(options);
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

  /* -------------------------------------------- */

  /**
   * Apply the cart to the actor: deduct currency and create/update items. Nothing about the
   * actor changes until this runs.
   */
  static async #onConfirmPurchase() {
    const cart = Object.values(this._state.cart);
    if ( !cart.length ) {
      ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.PurchaseNone"));
      return;
    }

    const spent = cart.reduce((sum, {price, quantity}) => sum + (price * quantity), 0);
    const currency = this.actor.system.currency ?? 0;
    if ( spent > currency ) {
      ui.notifications.error(game.i18n.localize("CRUCIBLE_SHOP.PurchaseFailed"));
      return;
    }

    const toCreate = [];
    const toUpdate = [];
    let count = 0;
    for ( const {item, quantity} of cart ) {
      if ( quantity <= 0 ) continue;
      count += quantity;
      const isStackable = item.system.properties?.has?.("stackable");

      if ( isStackable ) {
        const existing = this.actor.items.find(i => i.getFlag(MODULE_ID, "sourceUuid") === item.uuid);
        if ( existing ) {
          toUpdate.push({_id: existing.id, "system.quantity": existing.system.quantity + quantity});
          continue;
        }
        const itemData = game.items.fromCompendium?.(item) ?? item.toObject();
        delete itemData._id;
        foundry.utils.setProperty(itemData, "system.quantity", quantity);
        foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.sourceUuid`, item.uuid);
        toCreate.push(itemData);
      }
      else {
        for ( let i = 0; i < quantity; i++ ) {
          const itemData = item.toObject();
          delete itemData._id;
          foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.sourceUuid`, item.uuid);
          toCreate.push(itemData);
        }
      }
    }

    await this.actor.update({"system.currency": currency - spent});
    if ( toCreate.length ) await this.actor.createEmbeddedDocuments("Item", toCreate);
    if ( toUpdate.length ) await this.actor.updateEmbeddedDocuments("Item", toUpdate);

    ui.notifications.info(game.i18n.format("CRUCIBLE_SHOP.PurchaseSuccess", {count, spent: CrucibleShopApp.formatCurrency(spent)}));
    this._state.cart = {};
    await this.render({parts: ["shop"]});
  }
}
