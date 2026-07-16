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

/** @type {Map<string, number>} Chat message id -> pending setTimeout handle for its expiry. */
const expiryTimeouts = new Map();

/** @type {{id: string, name: string, mode: "default"|"custom", itemUuids: string[]}} */
const DEFAULT_SHOP = {id: "default", name: "General Store", mode: "default", itemUuids: [], buyRate: 100, sellRate: 100,
  requireApproval: false};

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

  game.settings.register(MODULE_ID, "approvalMethod", {
    name: "CRUCIBLE_SHOP.ApprovalMethod",
    hint: "CRUCIBLE_SHOP.ApprovalMethodHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      chat: "CRUCIBLE_SHOP.ApprovalMethodChat",
      panel: "CRUCIBLE_SHOP.ApprovalMethodPanel",
      both: "CRUCIBLE_SHOP.ApprovalMethodBoth"
    },
    default: "both"
  });

  game.settings.register(MODULE_ID, "messageExpiration", {
    name: "CRUCIBLE_SHOP.MessageExpiration",
    hint: "CRUCIBLE_SHOP.MessageExpirationHint",
    scope: "world",
    config: true,
    type: Number,
    default: 0
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

  // Bind clicks on "open shop" and transaction approve/deny chat buttons, in both the modern
  // (v13+) and legacy chat render hooks.
  Hooks.on("renderChatMessageHTML", (message, html) => bindChatButtons(message, html));
  Hooks.on("renderChatMessage", (message, html) => bindChatButtons(message, html[0] ?? html));

  // A non-GM seller can't write the world-scoped "shops" setting themselves, so a sale to a
  // custom shop is whispered to an online GM as a quiet chat message; whichever GM client sees it
  // first performs the actual restock. No sockets required - same pattern as the invite buttons.
  // This also doubles as the signal to refresh any open Shop Manager's Pending Requests panel.
  Hooks.on("createChatMessage", message => {
    if ( message.getFlag(MODULE_ID, "transactionRequest") ) refreshOpenManagers();
    scheduleMessageExpiry(message);
    if ( !game.user.isGM ) return;
    const request = message.getFlag(MODULE_ID, "sellRestock");
    if ( !request ) return;
    performRestock(request.shopId, request.soldItems);
  });

  Hooks.on("deleteChatMessage", message => {
    const timeout = expiryTimeouts.get(message.id);
    if ( timeout ) {
      clearTimeout(timeout);
      expiryTimeouts.delete(message.id);
    }
  });

  // Re-establish expiry timers for any still-pending expiring messages left over from before this
  // client (re)loaded, e.g. after a world restart or a GM reconnecting mid-session.
  if ( game.user.isGM ) {
    for ( const message of game.messages ) scheduleMessageExpiry(message);
  }

  // When a shop requires GM approval, the requesting player's own client learns the outcome by
  // watching for the whispered request message to be updated (by whichever GM approved/denied
  // it) rather than through a socket. Also refreshes any open Shop Manager panel.
  Hooks.on("updateChatMessage", message => {
    const request = message.getFlag(MODULE_ID, "transactionRequest");
    if ( !request ) return;
    refreshOpenManagers();
    if ( (request.status === "pending") || (request.userId !== game.user.id) ) return;
    for ( const app of foundry.applications.instances.values() ) {
      if ( (app instanceof CrucibleShopApp) && (app._state.pendingRequest?.id === request.id) ) {
        app.resolvePendingTransaction(request);
      }
    }
  });

  game.modules.get(MODULE_ID).api = {
    openShop,
    inviteToShop,
    getShops,
    getShop,
    saveShop,
    deleteShop,
    restockCustomShop,
    applyPurchase,
    applySell,
    requestTransactionApproval,
    resolveTransactionRequest,
    getPendingTransactionRequests,
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
/*  Applying Transactions                        */
/* -------------------------------------------- */

/**
 * Apply a purchase to an actor: deduct currency and create/update items. Shared by the instant
 * (no-approval-required) path and by a GM approving a pending request, so nothing about the
 * actor changes until this actually runs.
 * @param {Actor} actor
 * @param {{uuid: string, quantity: number, price: number}[]} entries
 * @returns {Promise<{count: number, spent: number}|{failed: true, reason: string}>}
 */
export async function applyPurchase(actor, entries) {
  const resolved = [];
  let spent = 0;
  for ( const {uuid, quantity, price} of entries ) {
    if ( quantity <= 0 ) continue;
    const item = await fromUuid(uuid);
    if ( !item ) continue;
    resolved.push({item, uuid, quantity});
    spent += price * quantity;
  }

  const currency = actor.system.currency ?? 0;
  if ( spent > currency ) return {failed: true, reason: "insufficient-funds"};

  const toCreate = [];
  const toUpdate = [];
  let count = 0;
  for ( const {item, uuid, quantity} of resolved ) {
    count += quantity;
    const isStackable = item.system.properties?.has?.("stackable");

    if ( isStackable ) {
      const existing = actor.items.find(i => i.getFlag(MODULE_ID, "sourceUuid") === uuid);
      if ( existing ) {
        toUpdate.push({_id: existing.id, "system.quantity": existing.system.quantity + quantity});
        continue;
      }
      const itemData = game.items.fromCompendium?.(item) ?? item.toObject();
      delete itemData._id;
      foundry.utils.setProperty(itemData, "system.quantity", quantity);
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.sourceUuid`, uuid);
      toCreate.push(itemData);
    }
    else {
      for ( let i = 0; i < quantity; i++ ) {
        const itemData = item.toObject();
        delete itemData._id;
        foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.sourceUuid`, uuid);
        toCreate.push(itemData);
      }
    }
  }

  await actor.update({"system.currency": currency - spent});
  if ( toCreate.length ) await actor.createEmbeddedDocuments("Item", toCreate);
  if ( toUpdate.length ) await actor.updateEmbeddedDocuments("Item", toUpdate);

  return {count, spent};
}

/**
 * Apply a sale to an actor: pay out currency and remove/decrement the sold items, restocking a
 * custom shop's stock if applicable. Shared by the instant path and GM approval.
 * @param {Actor} actor
 * @param {object} shop
 * @param {{itemId: string, quantity: number, unitPrice: number}[]} entries
 * @returns {Promise<{count: number, earned: number}>}
 */
export async function applySell(actor, shop, entries) {
  const toDelete = [];
  const toUpdate = [];
  const restock = [];
  let count = 0;
  let earned = 0;
  for ( const {itemId, quantity, unitPrice} of entries ) {
    if ( quantity <= 0 ) continue;
    const item = actor.items.get(itemId);
    if ( !item ) continue;
    count += quantity;
    earned += unitPrice * quantity;
    restock.push({itemData: item.toObject(), unitPrice});

    const owned = item.system.quantity ?? 1;
    if ( (item.system.quantity != null) && (quantity < owned) ) {
      toUpdate.push({_id: item.id, "system.quantity": owned - quantity});
    }
    else {
      toDelete.push(item.id);
    }
  }

  const currency = actor.system.currency ?? 0;
  await actor.update({"system.currency": currency + earned});
  if ( toUpdate.length ) await actor.updateEmbeddedDocuments("Item", toUpdate);
  if ( toDelete.length ) await actor.deleteEmbeddedDocuments("Item", toDelete);
  if ( shop.mode === "custom" ) await restockCustomShop(shop.id, restock);

  return {count, earned};
}

/**
 * Find every transaction request currently awaiting a decision, optionally scoped to one shop.
 * Used by the Shop Manager's Pending Requests panel.
 * @param {string} [shopId]
 * @returns {{messageId: string, request: object}[]}
 */
export function getPendingTransactionRequests(shopId=null) {
  const results = [];
  for ( const message of game.messages ) {
    const request = message.getFlag(MODULE_ID, "transactionRequest");
    if ( !request || (request.status !== "pending") ) continue;
    if ( shopId && (request.shopId !== shopId) ) continue;
    results.push({messageId: message.id, request});
  }
  return results;
}

/**
 * Re-render any currently open Shop Manager windows, e.g. so a new pending request appears (or a
 * resolved one disappears) without the GM needing to manually refresh.
 */
function refreshOpenManagers() {
  for ( const app of foundry.applications.instances.values() ) {
    if ( app instanceof CrucibleShopManagerApp ) app.render({parts: ["manager"]});
  }
}

/* -------------------------------------------- */
/*  GM-Confirmed Transactions                    */
/* -------------------------------------------- */

/**
 * Whisper a pending buy/sell request to any online GM (and the requester) for approval. A shop
 * with `requireApproval` set routes through here instead of applying instantly.
 * @param {{kind: "buy"|"sell", shop: object, actor: Actor, entries: object[], total: number}} data
 * @returns {Promise<{message: ChatMessage, requestId: string}|null>}   Null if no GM is online.
 */
export async function requestTransactionApproval({kind, shop, actor, entries, total}) {
  const gmIds = game.users.filter(u => u.isGM && u.active).map(u => u.id);
  if ( !gmIds.length ) {
    ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.NoGMOnline"));
    return null;
  }

  const request = {
    id: foundry.utils.randomID(),
    kind,
    shopId: shop.id,
    shopName: shop.name,
    actorUuid: actor.uuid,
    actorName: actor.name,
    userId: game.user.id,
    userName: game.user.name,
    entries,
    total,
    status: "pending"
  };

  const whisperIds = Array.from(new Set([...gmIds, game.user.id]));
  const flags = {[MODULE_ID]: {transactionRequest: request}};
  const delay = getExpirationDelayMs();
  if ( delay > 0 ) flags[MODULE_ID].expiresAt = Date.now() + delay;
  const message = await ChatMessage.create({
    content: renderTransactionCard(request),
    whisper: whisperIds,
    flags
  });

  return {message, requestId: request.id};
}

/**
 * Approve or deny a pending transaction request. GM only.
 * @param {string} messageId
 * @param {"approved"|"denied"} decision
 * @returns {Promise<void>}
 */
export async function resolveTransactionRequest(messageId, decision) {
  if ( !game.user.isGM ) return;
  const message = game.messages.get(messageId);
  if ( !message ) return;
  const request = message.getFlag(MODULE_ID, "transactionRequest");
  if ( !request || (request.status !== "pending") ) return; // Already resolved by another GM.

  let status = decision;
  let result = null;
  if ( decision === "approved" ) {
    const actor = await fromUuid(request.actorUuid);
    if ( !actor ) status = "failed";
    else {
      try {
        const shop = getShop(request.shopId);
        result = (request.kind === "buy")
          ? await applyPurchase(actor, request.entries)
          : await applySell(actor, shop, request.entries);
        if ( result?.failed ) status = "failed";
      } catch(err) {
        console.error(`${MODULE_ID} | Failed to apply an approved transaction`, err);
        status = "failed";
      }
    }
  }

  const resolved = {...request, status, result};
  await message.update({
    content: renderTransactionCard(resolved),
    [`flags.${MODULE_ID}.transactionRequest`]: resolved
  });
}

/**
 * Render the chat card HTML for a transaction request, at any stage of its lifecycle.
 * @param {object} request
 * @returns {string}
 */
function renderTransactionCard(request) {
  const {kind, shopName, actorName, userName, entries, total, status} = request;
  const isBuy = kind === "buy";
  const method = game.settings.get(MODULE_ID, "approvalMethod");
  const chatInteractive = (method === "chat") || (method === "both");

  const rows = entries.map(entry => {
    const unitPrice = isBuy ? entry.price : entry.unitPrice;
    return `<li>${entry.name} <span class="qty">x${entry.quantity}</span> - ${CrucibleShopApp.formatCurrency(unitPrice)}</li>`;
  }).join("");

  let statusHtml;
  if ( status === "pending" ) {
    statusHtml = chatInteractive ? `
      <div class="transaction-actions">
        <button type="button" class="deny" data-action="crucible-shop-deny">
          <i class="fa-solid fa-xmark"></i> ${game.i18n.localize("CRUCIBLE_SHOP.Deny")}
        </button>
        <button type="button" class="approve" data-action="crucible-shop-approve">
          <i class="fa-solid fa-check"></i> ${game.i18n.localize("CRUCIBLE_SHOP.Approve")}
        </button>
      </div>` : `<p class="transaction-status pending">
        <i class="fa-solid fa-hourglass-half"></i> ${game.i18n.localize("CRUCIBLE_SHOP.SeeShopManager")}</p>`;
  }
  else if ( status === "approved" ) {
    statusHtml = `<p class="transaction-status approved">
      <i class="fa-solid fa-check"></i> ${game.i18n.localize("CRUCIBLE_SHOP.RequestApproved")}</p>`;
  }
  else if ( status === "denied" ) {
    statusHtml = `<p class="transaction-status denied">
      <i class="fa-solid fa-xmark"></i> ${game.i18n.localize("CRUCIBLE_SHOP.RequestDenied")}</p>`;
  }
  else {
    statusHtml = `<p class="transaction-status failed">
      <i class="fa-solid fa-triangle-exclamation"></i> ${game.i18n.localize("CRUCIBLE_SHOP.RequestFailed")}</p>`;
  }

  const titleKey = isBuy ? "CRUCIBLE_SHOP.TransactionBuyTitle" : "CRUCIBLE_SHOP.TransactionSellTitle";
  const totalKey = isBuy ? "CRUCIBLE_SHOP.TotalCost" : "CRUCIBLE_SHOP.TotalPayout";

  return `
    <div class="crucible-shop-transaction status-${status}">
      <p>${game.i18n.format(titleKey, {user: userName, actor: actorName, shop: shopName})}</p>
      <ul class="transaction-items">${rows}</ul>
      <p class="transaction-total">${game.i18n.format(totalKey, {total: CrucibleShopApp.formatCurrency(total)})}</p>
      ${statusHtml}
    </div>`;
}

/* -------------------------------------------- */
/*  Opening a Shop                               */
/* -------------------------------------------- */

/**
 * Resolve which actor a user should shop as: their assigned character, or (mainly for GMs, who
 * own every actor) their one owned Hero. If more than one owned Hero exists and none is assigned
 * as the user's character, prompt them to choose which one is shopping - this is the common GM
 * case, since a GM owns every Hero in the world but usually isn't playing one personally.
 * @param {object} [options]
 * @param {boolean} [options.warn=true]   Show a ui.notifications.warn when no actor is available
 *                                        at all (not shown if the user cancels a choice prompt).
 * @returns {Promise<Actor|null>}
 */
export async function resolveShopActor({warn=true}={}) {
  const assigned = game.user.character?.isOwner ? game.user.character : null;
  if ( assigned ) return assigned;

  const heroes = game.actors.filter(a => (a.type === "hero") && a.isOwner);
  if ( heroes.length === 1 ) return heroes[0];

  if ( heroes.length > 1 ) return promptActorChoice(heroes);

  if ( warn ) ui.notifications.warn(game.i18n.localize("CRUCIBLE_SHOP.NoActor"));
  return null;
}

/* -------------------------------------------- */

/**
 * Prompt the user to pick which of several owned Hero actors is shopping.
 * @param {Actor[]} actors
 * @returns {Promise<Actor|null>}   The chosen actor, or null if the dialog was cancelled.
 */
async function promptActorChoice(actors) {
  const fields = foundry.data.fields;
  const _loc = game.i18n.localize.bind(game.i18n);

  const actorField = new fields.StringField({
    label: _loc("CRUCIBLE_SHOP.ChooseActor"),
    choices: Object.fromEntries(actors.map(a => [a.uuid, a.name]))
  });

  const dialogHTML = document.createElement("div");
  dialogHTML.append(actorField.toFormGroup(
    {hint: _loc("CRUCIBLE_SHOP.ChooseActorHint")},
    {name: "actorUuid", value: actors[0].uuid}
  ));

  const actorUuid = await foundry.applications.api.DialogV2.prompt({
    window: {title: _loc("CRUCIBLE_SHOP.ChooseActorTitle"), icon: "fa-solid fa-users"},
    position: {width: 400},
    content: dialogHTML,
    ok: {
      label: _loc("CRUCIBLE_SHOP.Preview"),
      icon: "fa-solid fa-eye",
      callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object.actorUuid
    },
    rejectClose: false
  });
  return actorUuid ? fromUuidSync(actorUuid) : null;
}

/* -------------------------------------------- */

/**
 * Open a shop application for a given (or auto-detected) actor.
 * @param {Actor} [actor]     The actor doing the shopping. Defaults to the current user's assigned
 *                            character, their one owned Hero, or a GM's choice among several.
 * @param {string} [shopId]   The shop to open. Defaults to the built-in default shop.
 * @returns {Promise<Application|null>}
 */
export async function openShop(actor, shopId="default") {
  actor ??= await resolveShopActor();
  if ( !actor ) return null;

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
  const delay = getExpirationDelayMs();
  if ( delay > 0 ) foundry.utils.setProperty(messageData, `flags.${MODULE_ID}.expiresAt`, Date.now() + delay);
  return ChatMessage.create(messageData);
}

/* -------------------------------------------- */
/*  Message Expiration                           */
/* -------------------------------------------- */

/**
 * The GM-configured expiration delay, in milliseconds. 0 means expiration is disabled.
 * @returns {number}
 */
function getExpirationDelayMs() {
  const minutes = Number(game.settings.get(MODULE_ID, "messageExpiration")) || 0;
  return minutes > 0 ? minutes * 60 * 1000 : 0;
}

/**
 * If a chat message carries this module's `expiresAt` flag, schedule (or immediately perform) its
 * deletion. Only a GM client does the actual scheduling/deleting - every client would otherwise
 * race to delete the same message and log spurious "not found" errors. This is safe to call
 * multiple times for the same message; a second call is a no-op while a timer is already pending.
 * @param {ChatMessage} message
 */
function scheduleMessageExpiry(message) {
  if ( !game.user.isGM ) return;
  const expiresAt = message.getFlag(MODULE_ID, "expiresAt");
  if ( !expiresAt ) return;
  if ( expiryTimeouts.has(message.id) ) return;

  const deleteIfPresent = async () => {
    expiryTimeouts.delete(message.id);
    const current = game.messages.get(message.id);
    if ( !current ) return; // Already gone (deleted manually, or by another process).
    try {
      await current.delete();
    } catch(err) {
      console.error(`${MODULE_ID} | Failed to delete an expired chat message`, err);
    }
  };

  const delay = expiresAt - Date.now();
  if ( delay <= 0 ) { deleteIfPresent(); return; }
  expiryTimeouts.set(message.id, setTimeout(deleteIfPresent, delay));
}

/* -------------------------------------------- */
/*  Chat Button Binding                          */
/* -------------------------------------------- */

/**
 * Bind click handlers to any "open shop" or transaction approve/deny buttons within a rendered
 * chat message. Safe to call multiple times on the same element (buttons are marked once bound).
 * @param {ChatMessage} message
 * @param {HTMLElement|null} html
 */
function bindChatButtons(message, html) {
  if ( !html ) return;

  const openButtons = html.querySelectorAll?.('[data-action="crucible-shop-open"]') ?? [];
  for ( const button of openButtons ) {
    if ( button.dataset.shopBound ) continue;
    button.dataset.shopBound = "true";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      await openShop(undefined, button.dataset.shopId);
    });
  }

  const decisionButtons = html.querySelectorAll?.(
    '[data-action="crucible-shop-approve"], [data-action="crucible-shop-deny"]') ?? [];
  for ( const button of decisionButtons ) {
    if ( button.dataset.shopBound ) continue;
    button.dataset.shopBound = "true";
    // Only a GM can act on these - everyone else simply doesn't see them.
    if ( !game.user.isGM ) { button.style.display = "none"; continue; }
    const decision = button.dataset.action === "crucible-shop-approve" ? "approved" : "denied";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      await resolveTransactionRequest(message.id, decision);
    });
  }
}
