import {MODULE_ID, getShops, saveShop, deleteShop, inviteToShop, openShop, getPendingTransactionRequests,
  resolveTransactionRequest, getTransactionHistory, undoTransaction} from "./crucible-shop.mjs";
import {CrucibleShopApp} from "./shop-app.mjs";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

// Default to a wide-open price range (0 - a high ceiling) rather than leaving price fields blank.
// A blank NumberField input resolves to 0, so priceMin AND priceMax would both land on 0 - a
// window that matches no real item.
const DEFAULT_PRICE_MIN = 0;
const DEFAULT_PRICE_MAX = 100000;

// Upper bound on how many items a single "Generate Items" click can roll at once, mostly to keep
// a mis-click from flooding chat with dozens of cards.
const MAX_RANDOMIZE_COUNT = 20;

// Name of the top-level Item folder that all shop-generated items are filed under.
const ROOT_FOLDER_NAME = "CrucibleShops";

/**
 * A GM-facing application for creating and curating shops.
 *
 * - The built-in "default" shop always exists, always pulls from the system's Equipment
 *   compendium tree, and cannot be deleted or switched to custom mode.
 * - Additional shops can be created in either mode:
 *     - "default" mode: also pulls from the Equipment compendium tree (useful for a second
 *       general store with a different name/flavor).
 *     - "custom" mode: stocked entirely by hand, by dragging Items onto the drop zone from the
 *       world, a compendium, or an actor sheet.
 * - From here the GM can also invite players to a shop, either as a public chat card or as a
 *   whisper to specific selected players.
 */
export class CrucibleShopManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "crucible-shop-manager",
    tag: "div",
    classes: ["crucible", "themed", "theme-dark", "crucible-shop-manager"],
    window: {
      title: "CRUCIBLE_SHOP.ManagerTitle",
      icon: "fa-solid fa-coins",
      resizable: true
    },
    position: {
      width: 760,
      height: 640
    },
    actions: {
      createShop: CrucibleShopManagerApp.#onCreateShop,
      selectShop: CrucibleShopManagerApp.#onSelectShop,
      deleteShop: CrucibleShopManagerApp.#onDeleteShop,
      removeItem: CrucibleShopManagerApp.#onRemoveItem,
      invitePublic: CrucibleShopManagerApp.#onInvitePublic,
      inviteWhisper: CrucibleShopManagerApp.#onInviteWhisper,
      openShop: CrucibleShopManagerApp.#onOpenShop,
      randomizeItems: CrucibleShopManagerApp.#onRandomizeItems,
      addFromCompendium: CrucibleShopManagerApp.#onAddFromCompendium,
      togglePanel: CrucibleShopManagerApp.#onTogglePanel
    }
  };

  /** @override */
  static PARTS = {
    manager: {
      id: "manager",
      template: "modules/crucible-shop/templates/shop-manager.hbs",
      scrollable: [".shop-list-panel", ".shop-panel-body"]
    }
  };

  /**
   * Which shop is currently selected in the left-hand list, and which of the lower panels
   * (items / invite / pending / history) is currently expanded to fill the available space - the
   * others collapse down to just their header, accordion-style.
   * @type {{selectedShopId: string, expandedPanel: "items"|"invite"|"pending"|"history"}}
   */
  _state = {selectedShopId: "default", expandedPanel: "items"};

  /* -------------------------------------------- */
  /*  Rendering                                    */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(_options) {
    const shops = getShops();
    const shopList = Object.values(shops).sort((a, b) => a.name.localeCompare(b.name));
    let selected = shops[this._state.selectedShopId];
    if ( !selected ) {
      selected = shopList[0] ?? null;
      if ( selected ) this._state.selectedShopId = selected.id;
    }
    if ( selected ) {
      selected.buyRate ??= 100;
      selected.sellRate ??= 100;
      selected.requireApproval ??= false;
    }

    let items = [];
    let itemGroups = [];
    if ( selected?.mode === "custom" ) {
      const priceOverrides = selected.itemPrices ?? {};
      items = await Promise.all((selected.itemUuids ?? []).map(async uuid => {
        const isCompendium = uuid.startsWith("Compendium.");
        const item = await fromUuid(uuid);
        if ( !item ) {
          return {uuid, name: game.i18n.localize("CRUCIBLE_SHOP.MissingItem"), img: "icons/svg/hazard.svg",
            price: 0, missing: true, isCompendium};
        }
        const quality = item.system?.quality;
        const QT = crucible?.CONST?.ITEM?.QUALITY_TIERS;
        const qualityTier = (quality && (quality !== "standard")) ? QT?.[quality] : null;
        const enchantment = item.system?.enchantment;
        const enchanted = !!enchantment && (enchantment !== "mundane");
        return {uuid, name: item.name, img: item.img, price: priceOverrides[uuid] ?? item.system?.price ?? 0,
          isCompendium, quality: qualityTier ? quality : null,
          qualityLabel: qualityTier ? game.i18n.localize(qualityTier.label) : null, enchanted};
      }));

      // Items stay wherever they actually live - compendium items are never copied into the
      // world - so grouping here is purely a display convenience: it lets a GM see and browse
      // "everything this shop pulled from a compendium" separately from items that live in the
      // world (dragged in manually, or generated via Randomize), without moving any documents.
      const compendiumItems = items.filter(i => i.isCompendium);
      const worldItems = items.filter(i => !i.isCompendium);
      itemGroups = [
        compendiumItems.length ? {key: "compendium", label: game.i18n.localize("CRUCIBLE_SHOP.SourceCompendium"), items: compendiumItems} : null,
        worldItems.length ? {key: "world", label: game.i18n.localize("CRUCIBLE_SHOP.SourceWorld"), items: worldItems} : null
      ].filter(_ => _);
    }

    const users = game.users.filter(u => !u.isGM).map(u => ({id: u.id, name: u.name, active: u.active}));

    const approvalMethod = game.settings.get(MODULE_ID, "approvalMethod");
    const showPendingPanel = (approvalMethod === "panel") || (approvalMethod === "both");
    const pendingRequests = (selected && showPendingPanel)
      ? getPendingTransactionRequests(selected.id).map(({messageId, request}) => {
        const isBuy = request.kind === "buy";
        return {
          messageId,
          kind: request.kind,
          isBuy,
          userName: request.userName,
          actorName: request.actorName,
          total: CrucibleShopApp.formatCurrency(request.total),
          entries: request.entries.map(e => ({
            name: e.name,
            img: e.img,
            quantity: e.quantity,
            unitPrice: isBuy ? e.price : e.unitPrice
          }))
        };
      })
      : [];

    const historyEntries = selected
      ? getTransactionHistory(selected.id, {limit: 50}).map(({messageId, history}) => {
        const isBuy = history.kind === "buy";
        return {
          messageId,
          kind: history.kind,
          isBuy,
          userName: history.userName,
          actorName: history.actorName,
          total: CrucibleShopApp.formatCurrency(history.total),
          timestamp: new Date(history.timestamp).toLocaleString(),
          entries: history.entries.map(e => ({name: e.name, img: e.img, quantity: e.quantity})),
          undone: history.undone,
          undoneByName: history.undoneByName
        };
      })
      : [];

    return {
      shops: shopList.map(s => ({...s, active: s.id === this._state.selectedShopId})),
      selected,
      isDefaultShop: selected?.id === "default",
      items,
      itemGroups,
      users,
      noUsers: !users.length,
      showPendingPanel,
      pendingRequests,
      noPendingRequests: showPendingPanel && !pendingRequests.length,
      historyEntries,
      noHistoryEntries: !historyEntries.length,
      expandedPanel: this._state.expandedPanel
    };
  }

  /* -------------------------------------------- */

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const dropzone = this.element.querySelector(".shop-item-drop");
    if ( dropzone ) {
      dropzone.addEventListener("dragover", event => event.preventDefault());
      dropzone.addEventListener("drop", this.#onDropItem.bind(this));
    }

    const nameInput = this.element.querySelector(".shop-name-input");
    nameInput?.addEventListener("change", this.#onChangeName.bind(this));

    const modeSelect = this.element.querySelector(".shop-mode-select");
    modeSelect?.addEventListener("change", this.#onChangeMode.bind(this));

    const buyRateInput = this.element.querySelector(".shop-buy-rate-input");
    buyRateInput?.addEventListener("change", this.#onChangeBuyRate.bind(this));

    const sellRateInput = this.element.querySelector(".shop-sell-rate-input");
    sellRateInput?.addEventListener("change", this.#onChangeSellRate.bind(this));

    const approvalCheckbox = this.element.querySelector(".shop-require-approval-input");
    approvalCheckbox?.addEventListener("change", this.#onChangeRequireApproval.bind(this));

    const itemList = this.element.querySelector(".shop-manager-item-list");
    itemList?.addEventListener("change", this.#onChangePrice.bind(this));

    const pendingList = this.element.querySelector(".pending-requests-list");
    pendingList?.addEventListener("click", this.#onClickPendingRequest.bind(this));

    const historyList = this.element.querySelector(".history-entries-list");
    historyList?.addEventListener("click", this.#onClickHistoryEntry.bind(this));
  }

  /* -------------------------------------------- */
  /*  Event Handlers                               */
  /* -------------------------------------------- */

  /**
   * Handle an Item being dropped onto the custom item drop zone.
   * @param {DragEvent} event
   */
  async #onDropItem(event) {
    event.preventDefault();
    let data;
    try {
      data = JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch(err) {
      return;
    }
    if ( data?.type !== "Item" ) return;

    const item = await Item.implementation.fromDropData(data);
    if ( !item ) return;

    const shops = getShops();
    const shop = shops[this._state.selectedShopId];
    if ( !shop || (shop.mode !== "custom") ) {
      ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.SelectCustomFirst"));
      return;
    }

    shop.itemUuids ??= [];
    if ( !shop.itemUuids.includes(item.uuid) ) shop.itemUuids.push(item.uuid);
    await saveShop(shop);
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  async #onChangeName(event) {
    const shops = getShops();
    const shop = shops[this._state.selectedShopId];
    if ( !shop ) return;
    shop.name = event.target.value.trim() || shop.name;
    await saveShop(shop);
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  async #onChangeMode(event) {
    const shops = getShops();
    const shop = shops[this._state.selectedShopId];
    if ( !shop || (shop.id === "default") ) return;
    shop.mode = event.target.value;
    shop.itemUuids ??= [];
    await saveShop(shop);
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  /**
   * Handle the GM editing the percentage of an item's price players receive when selling to
   * this shop.
   * @param {Event} event
   */
  /**
   * Handle the GM editing this shop's buy rate - the percentage of an item's listed price
   * players pay to buy it here (e.g. 80 for "80% of value").
   * @param {Event} event
   */
  async #onChangeBuyRate(event) {
    const shops = getShops();
    const shop = shops[this._state.selectedShopId];
    if ( !shop ) return;
    const raw = Number(event.target.value ?? 100);
    shop.buyRate = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 100;
    await saveShop(shop);
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  /**
   * Handle the GM editing this shop's sell rate - the percentage of an item's listed price
   * players are paid when selling it here (e.g. 120 for "120% of value").
   * @param {Event} event
   */
  async #onChangeSellRate(event) {
    const shops = getShops();
    const shop = shops[this._state.selectedShopId];
    if ( !shop ) return;
    const raw = Number(event.target.value ?? 100);
    shop.sellRate = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 100;
    await saveShop(shop);
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  /**
   * Handle the GM toggling whether this shop's transactions need explicit GM approval before
   * they apply, rather than resolving instantly on the player's client.
   * @param {Event} event
   */
  async #onChangeRequireApproval(event) {
    const shops = getShops();
    const shop = shops[this._state.selectedShopId];
    if ( !shop ) return;
    shop.requireApproval = event.target.checked;
    await saveShop(shop);
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  /**
   * Handle a click on an Approve or Deny button in the Pending Requests panel. Delegates to the
   * same resolveTransactionRequest used by the chat card buttons, so a request can be resolved
   * from either place interchangeably.
   * @param {PointerEvent} event
   */
  async #onClickPendingRequest(event) {
    const button = event.target.closest("[data-action]");
    if ( !button ) return;
    const action = button.dataset.action;
    if ( (action !== "approveRequest") && (action !== "denyRequest") ) return;
    const messageId = button.closest("[data-message-id]")?.dataset.messageId;
    if ( !messageId ) return;
    await resolveTransactionRequest(messageId, action === "approveRequest" ? "approved" : "denied");
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  /**
   * Handle the GM clicking Undo on an entry in the Transaction History panel.
   * @param {MouseEvent} event
   */
  async #onClickHistoryEntry(event) {
    const button = event.target.closest('[data-action="undoHistoryEntry"]');
    if ( !button ) return;
    const messageId = button.closest("[data-message-id]")?.dataset.messageId;
    if ( !messageId ) return;
    await undoTransaction(messageId);
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  /**
   * Handle the GM editing a custom shop item's price. This override always takes precedence over
   * the item's own price, which is how items with no price of their own (or a stale/missing one)
   * can still be sold in a custom shop.
   * @param {Event} event
   */
  async #onChangePrice(event) {
    const target = event.target.closest?.("[data-uuid]") ?? event.target;
    const uuid = target?.dataset?.uuid;
    if ( !uuid ) return;

    const shops = getShops();
    const shop = shops[this._state.selectedShopId];
    if ( !shop || (shop.mode !== "custom") ) return;

    const raw = Number(target.value ?? 0);
    const price = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
    shop.itemPrices ??= {};
    shop.itemPrices[uuid] = price;
    await saveShop(shop);
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  static async #onCreateShop() {
    const id = foundry.utils.randomID();
    const shop = {id, name: game.i18n.localize("CRUCIBLE_SHOP.NewShop"), mode: "custom", itemUuids: [], buyRate: 100, sellRate: 100, requireApproval: false};
    await saveShop(shop);
    this._state.selectedShopId = id;
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  static async #onSelectShop(_event, target) {
    this._state.selectedShopId = target.closest("[data-shop-id]").dataset.shopId;
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  /**
   * Expand one of the three lower accordion panels (items / invite / pending), collapsing the
   * other two down to just their header. Re-clicking the already-expanded panel's header does
   * nothing - there's always exactly one panel expanded, never zero, so there's always somewhere
   * for the available vertical space to go.
   */
  static async #onTogglePanel(_event, target) {
    const panel = target.closest("[data-panel]")?.dataset.panel;
    if ( !panel || (panel === this._state.expandedPanel) ) return;
    this._state.expandedPanel = panel;
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  static async #onDeleteShop(event, target) {
    event.stopPropagation();
    const shopId = target.closest("[data-shop-id]").dataset.shopId;
    if ( shopId === "default" ) {
      ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.CannotDeleteDefault"));
      return;
    }
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {title: game.i18n.localize("CRUCIBLE_SHOP.DeleteShop")},
      content: `<p>${game.i18n.localize("CRUCIBLE_SHOP.DeleteShopConfirm")}</p>`
    });
    if ( !confirmed ) return;
    await deleteShop(shopId);
    if ( this._state.selectedShopId === shopId ) this._state.selectedShopId = "default";
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  static async #onRemoveItem(_event, target) {
    const uuid = target.closest("[data-uuid]").dataset.uuid;
    const shops = getShops();
    const shop = shops[this._state.selectedShopId];
    if ( !shop ) return;
    shop.itemUuids = (shop.itemUuids ?? []).filter(u => u !== uuid);
    if ( shop.itemPrices ) delete shop.itemPrices[uuid];
    await saveShop(shop);
    await this.render({parts: ["manager"]});
  }

  /* -------------------------------------------- */

  static async #onInvitePublic() {
    await inviteToShop(this._state.selectedShopId, []);
  }

  /* -------------------------------------------- */

  static async #onInviteWhisper() {
    const checked = this.element.querySelectorAll('input[name="inviteUser"]:checked');
    const userIds = Array.from(checked).map(el => el.value);
    if ( !userIds.length ) {
      ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.SelectPlayersFirst"));
      return;
    }
    await inviteToShop(this._state.selectedShopId, userIds);
  }

  /* -------------------------------------------- */

  static async #onOpenShop() {
    await openShop(undefined, this._state.selectedShopId);
  }

/* -------------------------------------------- */

/**
 * Find (or create) the world Item folder that randomized items for a given shop should be filed
 * into: a top-level "CrucibleShops" folder, with one child subfolder per shop, named after the
 * shop. Reuses existing folders where they already exist rather than creating duplicates on every
 * generate click.
 * @param {{name: string}} shop  The shop being stocked.
 * @returns {Promise<Folder|null>}  The shop's subfolder, or null if folder creation failed.
 */
static async #getOrCreateShopFolder(shop) {
  try {
    let root = game.folders.find(f => (f.type === "Item") && !f.folder && (f.name === ROOT_FOLDER_NAME));
    if ( !root ) {
      root = await Folder.implementation.create({name: ROOT_FOLDER_NAME, type: "Item", folder: null});
    }

    const shopName = shop.name || "Shop";
    let sub = game.folders.find(f => (f.type === "Item") && (f.folder?.id === root.id) && (f.name === shopName));
    if ( !sub ) {
      sub = await Folder.implementation.create({name: shopName, type: "Item", folder: root.id});
    }
    return sub;
  } catch (err) {
    console.error("Crucible Shop | Failed to find or create shop item folder", err);
    return null;
  }
}

/* -------------------------------------------- */

/**
 * Prompt the GM for randomization parameters (mirroring the system's own
 * `CrucibleItem.randomizeDialog` form, plus a quantity and multi-tier quality picker of our own)
 * and generate one or more random items to stock a custom shop. GM only, and only for custom
 * shops.
 *
 * NOTE: this deliberately does NOT call `CrucibleItem.randomizeDialog()`. That method rolls an
 * item internally, posts a chat message built from THAT roll, but only returns the ChatMessage -
 * never the Item, and never the item's actual rolled price. The only thing it saves onto the
 * message's flags is the price MIN/MAX range that was fed in, not the result. Calling
 * `CrucibleItem.randomize()` a second time with that same range therefore rolls a brand new,
 * independent item with its own price - which is why the item added to the shop never matched
 * what was posted to chat, and why two unrelated things (a chat message, a shop item) came out of
 * one click. Rolling once here (per generated item) and reusing that single result for both the
 * shop and the chat card fixes both.
 */
static async #onRandomizeItems() {
  const shops = getShops();
  const shop = shops[this._state.selectedShopId];
  if ( !shop || (shop.mode !== "custom") ) return;

  const CrucibleItem = crucible?.api?.documents?.CrucibleItem;
  if ( typeof CrucibleItem?.randomize !== "function" ) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.RandomizeUnavailable"));
    return;
  }

  const data = await CrucibleShopManagerApp.#promptRandomizeParams();
  if ( !data ) return; // Dialog was cancelled.

  const count = Math.min(Math.max(Number(data.count) || 1, 1), MAX_RANDOMIZE_COUNT);
  const qualityChoices = Array.from(data.quality ?? []);

  // Resolve (or create) CrucibleShops/<Shop Name> once per batch rather than once per item.
  const folder = await CrucibleShopManagerApp.#getOrCreateShopFolder(shop);

  shop.itemUuids ??= [];
  const generated = [];
  let failures = 0;
  let lastError = null;

  for ( let i = 0; i < count; i++ ) {
    // Each item in the batch rolls its own quality independently from among the checked tiers,
    // so "check three tiers, generate ten items" yields a mixed spread rather than one tier
    // repeated ten times.
    const quality = qualityChoices.length
      ? qualityChoices[Math.floor(Math.random() * qualityChoices.length)]
      : undefined;

    let item;
    try {
      item = await CrucibleItem.randomize({
        price: {min: data.priceMin, max: data.priceMax},
        quality,
        itemTypes: data.itemTypes ?? [],
        baseUuid: data.baseUuid || undefined
      });

      // Persist the SAME item we are about to price and post - not a freshly re-rolled one.
      const itemData = item.toObject();
      if ( folder ) itemData.folder = folder.id;
      item = await Item.implementation.create(itemData, {
        temporary: false
      });
    } catch (err) {
      console.error("Crucible Shop | Failed to generate or persist a randomized item", err);
      lastError = err;
      failures++;
      continue;
    }

    if ( !item?.uuid || shop.itemUuids.includes(item.uuid) ) {
      failures++;
      continue;
    }

    shop.itemUuids.push(item.uuid);
    generated.push(item);
  }

  if ( !generated.length ) {
    // err.message here is often something actionable, e.g. "No eligible base items found for
    // the given constraints" when the price range/item types/quality combination is too narrow -
    // show that instead of a generic failure notice so the GM knows what to loosen.
    ui.notifications.error(lastError?.message || game.i18n.localize("CRUCIBLE_SHOP.RandomizeFailed"));
    return;
  }

  await saveShop(shop);
  await this.render({parts: ["manager"]});

  // Deliberately no chat message here: these items are shop stock, not loot being handed to
  // players. They already appear in the manager's item list immediately above, so a chat card
  // would only spoil shop contents to the whole table (or, whispered, be redundant with the UI
  // the GM is already looking at). Players see them once the GM actually invites them to the shop.

  if ( failures ) {
    ui.notifications.warn(
      game.i18n.format("CRUCIBLE_SHOP.RandomizePartial", {added: generated.length, failed: failures})
    );
  } else {
    ui.notifications.info(
      game.i18n.format("CRUCIBLE_SHOP.RandomizeSuccess", {count: generated.length})
    );
  }
}

/* -------------------------------------------- */

/**
 * Build and present the same randomization parameter form `CrucibleItem.randomizeDialog` uses,
 * without invoking that method's own internal roll+chat-message side effects.
 * @returns {Promise<object|null>} The submitted form data, or null if cancelled.
 */
static async #promptRandomizeParams() {
  const fields = foundry.data.fields;
  const _loc = game.i18n.localize.bind(game.i18n);
  const QT = crucible.CONST.ITEM.QUALITY_TIERS;
  const affixableTypes = crucible.CONST.ITEM.AFFIXABLE_ITEM_TYPES;

  const currencyInput = (field, config) => crucible.api.applications.elements.HTMLCrucibleCurrencyElement.create(config);
  // Default to a wide-open range (0 - a high ceiling) rather than leaving these blank. A blank
  // input resolves to 0, so priceMin AND priceMax both landed on 0 - a window that matches no
  // real item - which is why randomize() started throwing "No eligible base items found".
  const priceMinField = new fields.NumberField({label: _loc("ITEM.RANDOMIZE.PriceMin"), initial: DEFAULT_PRICE_MIN});
  const priceMaxField = new fields.NumberField({label: _loc("ITEM.RANDOMIZE.PriceMax"), initial: DEFAULT_PRICE_MAX});
  const countField = new fields.NumberField({label: _loc("CRUCIBLE_SHOP.RandomizeCount"),
    min: 1, max: MAX_RANDOMIZE_COUNT, step: 1, integer: true, initial: 1});
  const baseUuidField = new fields.DocumentUUIDField({label: _loc("ITEM.RANDOMIZE.BaseItem"),
    required: false, blank: true, type: "Item"});
  const itemTypesField = new fields.SetField(new fields.StringField({
    choices: Object.fromEntries(Array.from(affixableTypes).map(t => [t, game.i18n.localize(`TYPES.Item.${t}`)]))
  }), {label: _loc("ITEM.RANDOMIZE.ItemTypes")});
  const qualityField = new fields.SetField(new fields.StringField({
    choices: Object.fromEntries(Object.values(QT).map(q => [q.id, _loc(q.label)]))
  }), {label: _loc("ITEM.RANDOMIZE.Quality")});

  // Tiers with affix capacity are the ones the system's own randomizer will actually enchant with
  // prefixes/suffixes - "shoddy"/"standard" never get affixes no matter how many retries. Quick
  // way to guarantee a magic item without making the GM hunt through the quality tier list.
  const magicTierIds = Object.values(QT).filter(q => q.capacity > 0).map(q => q.id);
  const magicOnlyField = new fields.BooleanField({label: _loc("CRUCIBLE_SHOP.RandomizeMagicOnly")});

  // Same overflow risk as the compendium import dialog: itemTypes/quality are checkbox groups
  // whose length depends on the system's item type count and quality tier count, not fixed
  // markup, so a system with enough of either can push this past the viewport too. The whole
  // form body (not just the checkbox groups) is the scroll region - splitting scroll scope to
  // only wrap the checkboxes let a group get clipped mid-list with nothing on screen hinting
  // there was more below it. Foundry renders the dialog's footer as a sibling of this content,
  // so keeping it outside this div is what keeps the Generate button pinned and visible.
  // DialogV2 requires the element passed as `content` to have no attributes of its own, so the
  // scroll class goes on an inner wrapper instead of the outer element handed to `content`.
  const scrollRegion = document.createElement("div");
  scrollRegion.className = "crucible-shop-import-scroll";
  scrollRegion.append(
    priceMinField.toFormGroup({}, {name: "priceMin", input: currencyInput, value: DEFAULT_PRICE_MIN}),
    priceMaxField.toFormGroup({}, {name: "priceMax", input: currencyInput, value: DEFAULT_PRICE_MAX}),
    countField.toFormGroup({hint: _loc("CRUCIBLE_SHOP.RandomizeCountHint")}, {name: "count", value: 1}),
    baseUuidField.toFormGroup({}, {name: "baseUuid"}),
    itemTypesField.toFormGroup({stacked: true}, {name: "itemTypes", type: "checkboxes", value: Array.from(affixableTypes)}),
    magicOnlyField.toFormGroup(
      {hint: _loc("CRUCIBLE_SHOP.RandomizeMagicOnlyHint")},
      {name: "magicOnly", value: false}
    ),
    qualityField.toFormGroup(
      {stacked: true, hint: _loc("CRUCIBLE_SHOP.RandomizeQualityHint")},
      {name: "quality", type: "checkboxes", value: []}
    )
  );

  // Checking "Magic Items Only" checks every affix-capable tier for the GM. Left enabled (rather
  // than disabled) afterward - a disabled checkbox is omitted from FormData entirely, which would
  // submit an empty quality set (i.e. "any tier", including non-magic ones) instead of the
  // intended magic-only tiers. Leaving them enabled also lets the GM narrow the selection further
  // (e.g. "masterwork only") after the quick-select.
  const magicOnlyInput = scrollRegion.querySelector('[name="magicOnly"]');
  const qualityCheckboxes = Array.from(scrollRegion.querySelectorAll('input[name="quality"]'));
  magicOnlyInput?.addEventListener("change", () => {
    if ( !magicOnlyInput.checked ) return;
    for ( const box of qualityCheckboxes ) box.checked = magicTierIds.includes(box.value);
  });

  const dialogHTML = document.createElement("div");
  dialogHTML.append(scrollRegion);

  return foundry.applications.api.DialogV2.prompt({
    window: {title: _loc("ITEM.RANDOMIZE.Title"), icon: "fa-wand-sparkles", resizable: true},
    // Auto rather than a forced fixed height: the inner .crucible-shop-import-scroll div already
    // caps its own growth at 60vh, so the window can just size to whatever content there is
    // (short on a system with few item types/qualities, capped-and-scrollable on one with many)
    // instead of always opening at a fixed height that leaves empty space below a short list.
    position: {width: 520, height: "auto"},
    content: dialogHTML,
    ok: {
      label: _loc("ITEM.RANDOMIZE.Generate"),
      icon: "fa-solid fa-wand-sparkles",
      callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
    },
    rejectClose: false
  });
}

/* -------------------------------------------- */
/*  Bulk Import From Compendium                  */
/* -------------------------------------------- */

/**
 * Bulk-add every matching item from one or more compendium packs into a custom shop's item list -
 * e.g. "add every Weapon in the core Equipment compendiums" in a single click, instead of
 * dragging items in one at a time. Items already in the shop are skipped (never duplicated or
 * re-priced); everything else is added at the compendium item's own listed price, editable
 * afterward like any other item in the list. GM only, and only for custom shops.
 */
static async #onAddFromCompendium() {
  const shops = getShops();
  const shop = shops[this._state.selectedShopId];
  if ( !shop || (shop.mode !== "custom") ) return;

  const data = await CrucibleShopManagerApp.#promptCompendiumImportParams();
  if ( !data ) return; // Dialog was cancelled.
  if ( !data.packs?.length ) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.ImportSelectPackFirst"));
    return;
  }

  shop.itemUuids ??= [];
  const existing = new Set(shop.itemUuids);
  const typeFilter = new Set(data.itemTypes ?? []);
  const qualityFilter = new Set(data.qualityTiers ?? []);
  const priceMin = Number.isFinite(data.priceMin) ? data.priceMin : DEFAULT_PRICE_MIN;
  const priceMax = Number.isFinite(data.priceMax) ? data.priceMax : DEFAULT_PRICE_MAX;
  let added = 0;

  for ( const packId of data.packs ) {
    const pack = game.packs.get(packId);
    if ( !pack ) continue;
    let docs;
    try {
      docs = await pack.getDocuments();
    } catch(err) {
      console.error(`${MODULE_ID} | Failed to load compendium ${packId}`, err);
      continue;
    }
    for ( const item of docs ) {
      if ( typeFilter.size && !typeFilter.has(item.type) ) continue;
      if ( data.priceOnly && !item.system?.price ) continue;
      const price = item.system?.price ?? 0;
      if ( (price < priceMin) || (price > priceMax) ) continue;
      if ( qualityFilter.size && !qualityFilter.has(item.system?.quality) ) continue;
      if ( existing.has(item.uuid) ) continue;
      existing.add(item.uuid);
      shop.itemUuids.push(item.uuid);
      added++;
    }
  }

  if ( !added ) {
    ui.notifications.info(game.i18n.localize("CRUCIBLE_SHOP.ImportNoneAdded"));
    return;
  }

  await saveShop(shop);
  await this.render({parts: ["manager"]});
  ui.notifications.info(game.i18n.format("CRUCIBLE_SHOP.ImportSuccess", {count: added}));
}

/* -------------------------------------------- */

/**
 * Build and present the compendium bulk-import dialog: which pack(s) to pull from, which item
 * type(s) and quality tier(s) to include (leave all unchecked for every type/tier - e.g. check
 * only "Weapon" and "Armor" to pull in just those), an optional price range, and whether to skip
 * items with no price set.
 * @returns {Promise<{packs: string[], itemTypes: string[], qualityTiers: string[],
 *   priceMin: number, priceMax: number, priceOnly: boolean}|null>}
 */
static async #promptCompendiumImportParams() {
  const fields = foundry.data.fields;
  const _loc = game.i18n.localize.bind(game.i18n);
  const QT = crucible.CONST.ITEM.QUALITY_TIERS;

  const itemPacks = game.packs.filter(p => p.documentName === "Item");
  const equipmentPackIds = new Set(crucible?.CONFIG?.packs?.equipment ?? []);
  const itemTypes = (game.documentTypes?.Item ?? []).filter(t => t !== "base");

  const currencyInput = (field, config) => crucible.api.applications.elements.HTMLCrucibleCurrencyElement.create(config);

  const packsField = new fields.SetField(new fields.StringField({
    choices: Object.fromEntries(itemPacks.map(p => [p.collection, p.title]))
  }), {label: _loc("CRUCIBLE_SHOP.ImportPacks")});
  const itemTypesField = new fields.SetField(new fields.StringField({
    choices: Object.fromEntries(itemTypes.map(t => [t, _loc(`TYPES.Item.${t}`) || t]))
  }), {label: _loc("CRUCIBLE_SHOP.ImportItemTypes")});
  const qualityTiersField = new fields.SetField(new fields.StringField({
    choices: Object.fromEntries(Object.values(QT).map(q => [q.id, _loc(q.label)]))
  }), {label: _loc("ITEM.RANDOMIZE.Quality")});
  const priceMinField = new fields.NumberField({label: _loc("ITEM.RANDOMIZE.PriceMin"), initial: DEFAULT_PRICE_MIN});
  const priceMaxField = new fields.NumberField({label: _loc("ITEM.RANDOMIZE.PriceMax"), initial: DEFAULT_PRICE_MAX});
  const priceOnlyField = new fields.BooleanField({label: _loc("CRUCIBLE_SHOP.ImportPriceOnly")});

  // The three checkbox groups below (packs, item types, quality tiers) scale with how much
  // content this world has - a world with a dozen+ compendium packs can easily produce a dialog
  // taller than the viewport. With height: "auto" and no resizing, that pushed the Import button
  // off the bottom of the screen with no way to reach it. Fixing that: the whole form body (not
  // just the checkbox groups) is the scroll region - splitting scroll scope to only the checkbox
  // groups let a group (e.g. Quality Tier) get clipped mid-list with the price fields/footer
  // already visible below it, giving no hint there was more to scroll to above them. Foundry
  // renders the dialog's footer as a sibling of this content, so keeping it outside this div is
  // what keeps the Import button pinned and visible; the window itself can also be resized as a
  // fallback.
  // DialogV2 requires the element passed as `content` to have no attributes of its own, so the
  // scroll class goes on an inner wrapper instead of the outer element handed to `content`.
  const scrollRegion = document.createElement("div");
  scrollRegion.className = "crucible-shop-import-scroll";
  scrollRegion.append(
    packsField.toFormGroup(
      {stacked: true, hint: _loc("CRUCIBLE_SHOP.ImportPacksHint")},
      {name: "packs", type: "checkboxes",
        value: itemPacks.filter(p => equipmentPackIds.has(p.collection)).map(p => p.collection)}
    ),
    itemTypesField.toFormGroup(
      {stacked: true, hint: _loc("CRUCIBLE_SHOP.ImportItemTypesHint")},
      {name: "itemTypes", type: "checkboxes", value: []}
    ),
    qualityTiersField.toFormGroup(
      {stacked: true, hint: _loc("CRUCIBLE_SHOP.ImportQualityHint")},
      {name: "qualityTiers", type: "checkboxes", value: []}
    ),
    priceMinField.toFormGroup({hint: _loc("CRUCIBLE_SHOP.ImportPriceRangeHint")},
      {name: "priceMin", input: currencyInput, value: DEFAULT_PRICE_MIN}),
    priceMaxField.toFormGroup({}, {name: "priceMax", input: currencyInput, value: DEFAULT_PRICE_MAX}),
    priceOnlyField.toFormGroup({hint: _loc("CRUCIBLE_SHOP.ImportPriceOnlyHint")}, {name: "priceOnly", value: true})
  );
  const dialogHTML = document.createElement("div");
  dialogHTML.append(scrollRegion);

  return foundry.applications.api.DialogV2.prompt({
    window: {title: _loc("CRUCIBLE_SHOP.ImportTitle"), icon: "fa-solid fa-boxes-stacked", resizable: true},
    // Auto rather than a forced fixed height: the inner .crucible-shop-import-scroll div already
    // caps its own growth at 60vh, so the window can just size to whatever content there is
    // (short on a world with few compendiums, capped-and-scrollable on one with many) instead of
    // always opening at a fixed height that leaves empty space below a short list.
    position: {width: 520, height: "auto"},
    content: dialogHTML,
    ok: {
      label: _loc("CRUCIBLE_SHOP.ImportButton"),
      icon: "fa-solid fa-boxes-stacked",
      callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
    },
    rejectClose: false
  });
}
}
