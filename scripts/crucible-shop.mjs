/**
 * Crucible Shop
 * --------------------------------------------------------------------------
 * A standalone equipment shop for the Crucible system.
 *
 * Unlike `crucible-equipment-creator` (which reuses the Hero Creation
 * wizard's equipment step and can therefore only be opened on an unfinished,
 * level-0 Hero), this module talks to an actor's REAL currency and REAL
 * inventory. It is meant to be opened on already-created characters at any
 * point in the campaign - a general store, a blacksmith, a black market,
 * whatever the GM wants.
 *
 * - By default, a shop pulls its stock from the same compendium packs the
 *   character creator's Equipment step uses (`crucible.CONFIG.packs.equipment`).
 * - GMs can also define any number of custom shops with a hand-picked list
 *   of items (dragged in from the world, a compendium, or an actor sheet).
 * - GMs invite players via a chat message with a clickable button; each
 *   player who clicks it opens the shop locally for their own owned
 *   character. No sockets are required - everything happens on the
 *   inviting/clicking user's own client, exactly like a normal button in
 *   chat.
 */

import {CrucibleShopApp} from "./shop-app.mjs";
import {CrucibleShopManagerApp} from "./shop-manager-app.mjs";

export const MODULE_ID = "crucible-shop";

/** @type {{id: string, name: string, mode: "default"|"custom", itemUuids: string[]}} */
const DEFAULT_SHOP = {id: "default", name: "General Store", mode: "default", itemUuids: [], sellRate: 50};

/* -------------------------------------------- */
/*  Initialization                               */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "shops", {
    scope: "world",
    config: false,
    type: Object,
    default: {default: foundry.utils.deepClone(DEFAULT_SHOP)}
  });

  game.settings.registerMenu(MODULE_ID, "manageShops", {
    name: "CRUCIBLE_SHOP.ManagerTitle",
    label: "CRUCIBLE_SHOP.ManagerTitle",
    hint: "Create custom shops, curate their item lists, and invite players to shop.",
    icon: "fa-solid fa-coins",
    type: CrucibleShopManagerApp,
    restricted: true
  });
});

Hooks.once("ready", () => {
  if ( game.system.id !== "crucible" ) {
    console.warn(`${MODULE_ID} | This module only supports the Crucible system.`);
    return;
  }

  // Bind clicks on "open shop" chat buttons, in both the modern (v13+) and legacy chat render hooks.
  Hooks.on("renderChatMessageHTML", (message, html) => bindChatButtons(html));
  Hooks.on("renderChatMessage", (message, html) => bindChatButtons(html[0] ?? html));

  // A non-GM seller can't write the world-scoped "shops" setting themselves, so a sale to a
  // custom shop is whispered to an online GM as a quiet chat message; whichever GM client sees it
  // first performs the actual restock. No sockets required - same pattern as the invite buttons.
  Hooks.on("createChatMessage", message => {
    if ( !game.user.isGM ) return;
    const request = message.getFlag(MODULE_ID, "sellRestock");
    if ( !request ) return;
    performRestock(request.shopId, request.soldItems);
  });

  game.modules.get(MODULE_ID).api = {
    openShop,
    inviteToShop,
    getShops,
    getShop,
    saveShop,
    deleteShop,
    restockCustomShop,
    CrucibleShopApp,
    CrucibleShopManagerApp
  };

  // In case the Items directory already rendered before this "ready" hook ran, inject once here too.
  if ( ui.items?.rendered && ui.items.element ) injectShopManagerButton(ui.items, ui.items.element);
  function injectShopManagerButton(app, html) {
    if ( !game.user.isGM ) return;
    if ( game.system.id !== "crucible" ) return;

    const root = html instanceof HTMLElement ? html : html[0];
    if ( !root || root.querySelector(".crucible-shop-button") ) return;

    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("crucible-shop-button");
    button.innerHTML = `<i class="fas fa-store"></i> ${game.i18n.localize("CRUCIBLE_SHOP.ManagerTitle")}`;
    button.addEventListener("click", () => new CrucibleShopManagerApp().render({force: true}));
    const anchor = root.querySelector('[data-action="createFolder"]') ?? root.querySelector('[data-action="createEntry"]');
    if ( !anchor ) return;
    anchor.after(button);
  }

Hooks.on("renderItemDirectory", injectShopManagerButton);
  // Console/macro convenience.
  globalThis.crucibleShop = {
    open: openShop,
    invite: inviteToShop,
    manage: () => new CrucibleShopManagerApp().render({force: true})
  };
});

/* -------------------------------------------- */
/*  Shop Data Access                             */
/* -------------------------------------------- */

/**
 * Get all configured shops, keyed by id. Always includes at least the built-in default shop.
 * @returns {Record<string, object>}
 */
export function getShops() {
  const shops = foundry.utils.deepClone(game.settings.get(MODULE_ID, "shops") ?? {});
  if ( foundry.utils.isEmpty(shops) ) shops.default = foundry.utils.deepClone(DEFAULT_SHOP);
  return shops;
}

/**
 * Get a single shop definition by id, falling back to the default shop if not found.
 * @param {string} [shopId]
 * @returns {object}
 */
export function getShop(shopId) {
  const shops = getShops();
  return shops[shopId] ?? shops.default ?? foundry.utils.deepClone(DEFAULT_SHOP);
}

/**
 * Create or update a shop definition. GM only.
 * @param {object} shop   A shop definition with at least an `id`.
 * @returns {Promise<void>}
 */
export async function saveShop(shop) {
  if ( !game.user.isGM ) return ui.notifications.warn("Only the GM can manage shops.");
  const shops = game.settings.get(MODULE_ID, "shops") ?? {};
  shops[shop.id] = shop;
  await game.settings.set(MODULE_ID, "shops", shops);
}

/**
 * Delete a shop definition. GM only.
 * @param {string} shopId
 * @returns {Promise<void>}
 */
export async function deleteShop(shopId) {
  if ( !game.user.isGM ) return ui.notifications.warn("Only the GM can manage shops.");
  const shops = game.settings.get(MODULE_ID, "shops") ?? {};
  delete shops[shopId];
  await game.settings.set(MODULE_ID, "shops", shops);
}

/* -------------------------------------------- */
/*  Selling / Restocking                         */
/* -------------------------------------------- */

/**
 * Restock a custom shop with items a player just sold to it. If the caller is a GM, this happens
 * immediately. Otherwise the request is whispered to an online GM's client to perform on our
 * behalf, since only a GM can write the world-scoped "shops" setting.
 * @param {string} shopId
 * @param {{itemData: object, unitPrice: number}[]} soldItems
 * @returns {Promise<void>}
 */
export async function restockCustomShop(shopId, soldItems) {
  if ( !soldItems.length ) return;

  if ( game.user.isGM ) {
    await performRestock(shopId, soldItems);
    return;
  }

  const gmIds = game.users.filter(u => u.isGM && u.active).map(u => u.id);
  if ( !gmIds.length ) return; // No GM online to hand the restock off to - the sale still went through.

  await ChatMessage.create({
    content: `<p>${game.i18n.format("CRUCIBLE_SHOP.SellRestockNotice", {name: game.user.name})}</p>`,
    whisper: gmIds,
    flags: {[MODULE_ID]: {sellRestock: {shopId, soldItems}}}
  });
}

/**
 * Actually perform a restock: create a standalone world Item for each sold item and add it to the
 * shop's curated item list. GM only - callers must ensure that themselves.
 * @param {string} shopId
 * @param {{itemData: object, unitPrice: number}[]} soldItems
 * @returns {Promise<void>}
 */
async function performRestock(shopId, soldItems) {
  const shops = getShops();
  const shop = shops[shopId];
  if ( !shop || (shop.mode !== "custom") ) return;

  shop.itemUuids ??= [];
  shop.itemPrices ??= {};
  for ( const {itemData, unitPrice} of soldItems ) {
    const data = foundry.utils.deepClone(itemData);
    delete data._id;
    if ( data.system?.quantity != null ) data.system.quantity = 1;
    if ( data.flags ) delete data.flags[MODULE_ID];

    let created;
    try {
      created = await Item.implementation.create(data, {temporary: false});
    } catch(err) {
      console.error(`${MODULE_ID} | Failed to restock a sold item`, err);
      continue;
    }
    if ( !created?.uuid ) continue;

    shop.itemUuids.push(created.uuid);
    shop.itemPrices[created.uuid] = data.system?.price ?? unitPrice;
  }
  await saveShop(shop);
}

/* -------------------------------------------- */
/*  Opening a Shop                               */
/* -------------------------------------------- */

/**
 * Open a shop application for a given (or auto-detected) actor.
 * @param {Actor} [actor]     The actor doing the shopping. Defaults to the current user's assigned
 *                            character, or their first owned Hero actor.
 * @param {string} [shopId]   The shop to open. Defaults to the built-in default shop.
 * @returns {Promise<Application|null>}
 */
export async function openShop(actor, shopId="default") {
  actor ??= (game.user.character?.isOwner ? game.user.character : null)
    ?? game.actors.find(a => (a.type === "hero") && a.isOwner);

  if ( !actor ) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.NoActor"));
    return null;
  }

  const shop = getShop(shopId);
  const app = new CrucibleShopApp({actor, shop});
  await app.render({force: true});
  return app;
}

/* -------------------------------------------- */
/*  Chat Invitations                             */
/* -------------------------------------------- */

/**
 * Post a chat message inviting a set of users to open a shop. GM only.
 * @param {string} shopId
 * @param {string[]} [userIds]   Users to whisper the invite to. Omit/empty to post publicly.
 * @returns {Promise<ChatMessage>}
 */
export async function inviteToShop(shopId, userIds=[]) {
  if ( !game.user.isGM ) return ui.notifications.warn("Only the GM can invite players to a shop.");
  const shop = getShop(shopId);
  const content = `
    <div class="crucible-shop-invite">
      <p>${game.i18n.format("CRUCIBLE_SHOP.ChatIntro", {gm: game.user.name, name: shop.name})}</p>
      <button type="button" data-action="crucible-shop-open" data-shop-id="${shop.id}">
        <i class="fa-solid fa-coins"></i> ${game.i18n.format("CRUCIBLE_SHOP.ChatOpenShop", {name: shop.name})}
      </button>
    </div>`;
  const messageData = {content, speaker: {alias: game.user.name}};
  if ( userIds.length ) messageData.whisper = userIds;
  return ChatMessage.create(messageData);
}

/* -------------------------------------------- */
/*  Chat Button Binding                          */
/* -------------------------------------------- */

/**
 * Bind click handlers to any "open shop" buttons within a rendered chat message.
 * Safe to call multiple times on the same element (buttons are marked once bound).
 * @param {HTMLElement|null} html
 */
function bindChatButtons(html) {
  if ( !html ) return;
  const buttons = html.querySelectorAll?.('[data-action="crucible-shop-open"]');
  if ( !buttons?.length ) return;
  for ( const button of buttons ) {
    if ( button.dataset.shopBound ) continue;
    button.dataset.shopBound = "true";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      await openShop(undefined, button.dataset.shopId);
    });
  }
}
