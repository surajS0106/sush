//! Connectors: MCP servers the UI starts on demand and calls tools on, either
//! local processes or remote URLs. Configs live in the UI; Rust keeps the
//! running clients, keyed by id. Sign-in for remote ones is in connector_auth.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sush_core::mcp::{McpClient, McpError, McpTool, ServerSpec, ToolOutput};
use tauri::State;

use crate::connector_auth::{self, StoredTokens};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ConnectOutcome {
    #[serde(rename_all = "camelCase")]
    Ready { server_name: Option<String>, tools: Vec<McpTool> },
    /// A remote server wants a sign-in (or a fresh one) before it'll talk.
    /// `rejected` says why, when it turned down credentials we already had.
    NeedsAuth { rejected: Option<String> },
}

/// Plinth's MCP server: the design app on this computer (its catalog entry). It's the one connector
/// told which thread is calling, so Plinth can name the undo steps and show who's editing.
const PLINTH_PORT: u16 = 47440;

pub(crate) fn is_plinth(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| {
        matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")) && u.port() == Some(PLINTH_PORT)
    })
}

/// "Connection refused" from Plinth means it isn't running: say so plainly.
fn plinth_closed(e: McpError, url: &str) -> AppError {
    match &e {
        McpError::Request(r) if r.is_connect() && is_plinth(url) => AppError::NotFound("Plinth isn't open. Open Plinth and try again.".into()),
        _ => e.into(),
    }
}

fn ready(client: &McpClient) -> ConnectOutcome {
    ConnectOutcome::Ready { server_name: client.server_name.clone(), tools: client.tools.clone() }
}

/// Start the connector (or reuse it if it's already running for the same
/// server) and return its tools. A changed server restarts it.
#[tauri::command]
pub async fn connector_connect(state: State<'_, AppState>, id: String, server: ServerSpec) -> AppResult<ConnectOutcome> {
    let mut running = state.connectors.lock().await;
    if let Some((spec, client)) = running.get(&id) {
        if *spec == server {
            return Ok(ready(client));
        }
    }
    running.remove(&id); // dropping the client stops the old process or session
    let client = match &server {
        ServerSpec::Stdio(command) => McpClient::spawn(command).await?,
        ServerSpec::Http(remote) => {
            let tokens = StoredTokens::new(&id, &remote.url, state.http.clone());
            match McpClient::connect_http(state.http.clone(), &remote.url, Some(tokens)).await {
                Err(McpError::Unauthorized(challenge)) => {
                    let rejected = connector_auth::has_credentials(&id, &remote.url)
                        .then(|| challenge.reason.unwrap_or_else(|| "the server turned down the saved sign-in".into()));
                    return Ok(ConnectOutcome::NeedsAuth { rejected });
                }
                result => result.map_err(|e| plinth_closed(e, &remote.url))?,
            }
        }
    };
    let outcome = ready(&client);
    running.insert(id, (server, Arc::new(client)));
    Ok(outcome)
}

/// Call a tool on a running connector (agent runs do, see `runs.rs`). `thread` (id and title) goes
/// along only to Plinth.
pub(crate) async fn call(state: &AppState, id: String, tool: String, arguments: Value, thread: Option<(String, String)>) -> AppResult<ToolOutput> {
    // Don't hold the map lock across a long tool call.
    let (spec, client) = state
        .connectors
        .lock()
        .await
        .get(&id)
        .map(|(spec, c)| (spec.clone(), c.clone()))
        .ok_or_else(|| AppError::NotFound("connector isn't running; reconnect it in Customize → Connectors".into()))?;
    let plinth = match &spec {
        ServerSpec::Http(remote) if is_plinth(&remote.url) => Some(remote.url.clone()),
        _ => None,
    };
    let result = match (&plinth, thread) {
        (Some(_), Some((thread_id, title))) => {
            client.call_tool_with_meta(&tool, arguments, serde_json::json!({ "sush/thread": { "id": thread_id, "title": title } })).await
        }
        _ => client.call_tool(&tool, arguments).await,
    };
    match result {
        // Signed out or revoked mid-session: drop it so the next connect asks to sign in.
        Err(e @ McpError::Unauthorized(_)) => {
            state.connectors.lock().await.remove(&id);
            Err(e.into())
        }
        Err(e) => {
            if plinth.is_some() && matches!(&e, McpError::Request(r) if r.is_connect()) {
                // A closed Plinth leaves a dead client behind; drop it so the next connect starts fresh.
                state.connectors.lock().await.remove(&id);
            }
            Err(plinth_closed(e, plinth.as_deref().unwrap_or("")))
        }
        Ok(out) => Ok(out),
    }
}

/// Call a connector tool its server marks read-only (`readOnlyHint`), for the
/// workflow triggers that watch mail and calendars (`lib/workflow-engine.ts`).
/// Any other tool is refused: the webview can look through a connector, never act through one.
#[tauri::command]
pub async fn connector_read(state: State<'_, AppState>, id: String, tool: String, arguments: Value) -> AppResult<String> {
    let client = state
        .connectors
        .lock()
        .await
        .get(&id)
        .map(|(_, c)| c.clone())
        .ok_or_else(|| AppError::NotFound("connector isn't running; reconnect it in Customize → Connectors".into()))?;
    if !read_only(&client.tools, &tool) {
        return Err(AppError::Invalid(format!("“{tool}” isn't marked read-only by its server, so a trigger can't call it. Pick a search or list tool.")));
    }
    let out = call(&state, id, tool, arguments, None).await?;
    if out.is_error {
        return Err(AppError::Invalid(out.text));
    }
    Ok(out.text)
}

fn read_only(tools: &[sush_core::mcp::McpTool], name: &str) -> bool {
    tools
        .iter()
        .find(|t| t.name == name)
        .and_then(|t| t.annotations.as_ref())
        .and_then(|a| a.get("readOnlyHint"))
        .and_then(Value::as_bool)
        == Some(true)
}

#[cfg(test)]
mod read_only_tests {
    use super::*;

    fn tool(name: &str, annotations: Option<Value>) -> sush_core::mcp::McpTool {
        sush_core::mcp::McpTool { name: name.into(), description: None, input_schema: serde_json::json!({}), annotations, meta: None }
    }

    #[test]
    fn only_tools_marked_read_only_pass() {
        let tools = vec![
            tool("search", Some(serde_json::json!({ "readOnlyHint": true }))),
            tool("send", Some(serde_json::json!({ "readOnlyHint": false }))),
            tool("list", None),
        ];
        assert!(read_only(&tools, "search"));
        assert!(!read_only(&tools, "send"));
        assert!(!read_only(&tools, "list"));
        assert!(!read_only(&tools, "missing"));
    }
}

/// What Swiggy itself says an order would be, for the card that confirms it.
#[derive(Serialize)]
pub struct SwiggyOrderPreview {
    cart: String,
    addresses: String,
}

/// Read the live cart and saved addresses for the confirm card, so it shows
/// Swiggy's figures rather than the model's. Only these reads: the webview
/// doesn't get to call connector tools itself. `instamart` picks its cart tool
/// over Food's.
#[tauri::command]
pub async fn swiggy_order_preview(state: State<'_, AppState>, id: String, address_id: String, instamart: bool) -> AppResult<SwiggyOrderPreview> {
    let read = |tool: &str, arguments: Value| {
        let (state, id, tool) = (&*state, id.clone(), tool.to_string());
        async move {
            let out = call(state, id, tool, arguments, None).await?;
            if out.is_error {
                return Err(AppError::Invalid(if out.text.is_empty() { "Swiggy couldn't read this order.".into() } else { out.text }));
            }
            Ok::<String, AppError>(out.text)
        }
    };
    let cart = if instamart { read("get_cart", serde_json::json!({})) } else { read("get_food_cart", serde_json::json!({ "addressId": address_id })) };
    let (cart, addresses) = tokio::try_join!(cart, read("get_addresses", serde_json::json!({ "pageSize": 10 })))?;
    Ok(SwiggyOrderPreview { cart, addresses })
}

const SHOWN_AS_CARD: &str = "The user already sees this result in the app as a card with photos, prices and the bill. Don't write a table or list of these items, quantities, prices or charges. Reply in one short sentence, or ask what you need next.";

/// Instamart's results open with instructions for the model, such as "display the updated cart in a
/// tabular format", then the fields. The card shows those fields, so they'd only be repeated: an
/// instruction in the tool's description lost to these, so they're replaced here. Anything that isn't
/// instructions followed by JSON stays as it came.
pub(crate) fn instamart_for_model(model_tool: &str, tool: &str, text: String) -> String {
    if !model_tool.starts_with("instamart") {
        return text;
    }
    let note = match tool {
        "get_cart" => SHOWN_AS_CARD.to_string(),
        "update_cart" => format!(
            "{SHOWN_AS_CARD} Swiggy accepted this change, but the cart can still change afterwards, so say that it was accepted rather than promising it will stay."
        ),
        "search_products" | "your_go_to_items" => format!(
            "{SHOWN_AS_CARD} Add to the cart only what the user asked for: if a product they asked to add comes in several pack sizes, ask which one, then pass spinId and skuId from that variation to update_cart. The user can also add items from this card without sending a message, and you aren't told: when they say they've picked or selected something, call get_cart and work from that rather than asking them to choose again."
        ),
        "get_addresses" => return instamart_addresses_for_model(text),
        // Plain text and no cart, so this adds to the result rather than replacing anything.
        "clear_cart" => return format!("{text}\n\nThis doesn't confirm the cart stayed empty. Before saying it's cleared, call get_cart on its own and say what it shows."),
        _ => return text,
    };
    match text.find('{') {
        Some(start) if serde_json::from_str::<Value>(&text[start..]).is_ok() => format!("{note}\n\n{}", &text[start..]),
        _ => text,
    }
}

/// What a connector call returns to the thread. A note alone didn't stop the model repeating Instamart's
/// cart in a table, so item prices and the bill go under `cardOnly`: the card reads them, the model
/// never gets them (`CARD_ONLY` in `agent/ui.rs`). Anything that isn't a cart stays as text.
pub(crate) fn instamart_output(model_tool: &str, tool: &str, text: String) -> Value {
    let text = instamart_for_model(model_tool, tool, text);
    if !model_tool.starts_with("instamart") || !matches!(tool, "get_cart" | "update_cart") {
        return Value::String(text);
    }
    let Some(start) = text.find('{') else { return Value::String(text) };
    let Ok(cart) = serde_json::from_str::<Value>(&text[start..]) else { return Value::String(text) };
    serde_json::json!({
        "note": format!("{} Item prices and the bill are only on the card, so point the user there if they ask, and don't estimate them.", text[..start].trim()),
        "cart": instamart_cart_for_model(&cart),
        "cardOnly": { "result": cart },
    })
}

/// The cart without what only the card needs. Fields are removed by name, so a warning Swiggy adds later still reaches the model.
fn instamart_cart_for_model(cart: &Value) -> Value {
    let mut out = cart.clone();
    if let Some(fields) = out.as_object_mut() {
        for key in ["billBreakdown", "superData", "selectedAddressDetails"] {
            fields.remove(key);
        }
        for item in fields.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
            if let Some(item) = item.as_object_mut() {
                for key in ["mrp", "discountedFinalPrice", "imageUrl", "productId", "storeId", "maxQuantity", "maxQuantityMessage"] {
                    item.remove(key);
                }
            }
        }
    }
    out
}

/// `get_addresses` is text, and tells the model to ask the user to confirm its suggestion. The card
/// does that, so only what the card and the model need is kept: the count, the rows and the suggested id.
fn instamart_addresses_for_model(text: String) -> String {
    let rows: Vec<&str> = text.lines().filter(|line| line.contains("(ID:")).collect();
    if rows.is_empty() {
        return text;
    }
    let mut out = String::from("The user already sees these addresses in the app as a card and picks one there, which sends you its ID. Don't list or recommend them: ask in one short sentence to pick from the card, then wait. If they've already clearly named one, use its ID and carry on without asking.\n\n");
    if let Some(found) = text.lines().next().filter(|line| line.starts_with("Found")) {
        out.push_str(found);
        out.push('\n');
    }
    out.push_str(&rows.join("\n"));
    let suggested = text.split("preselected address ID:").nth(1).and_then(|rest| rest.split_whitespace().next());
    if let Some(id) = suggested {
        out.push_str(&format!("\n\nSuggested address ID: {}", id.trim_end_matches('.')));
    }
    out
}

/// A running client, for reads that aren't tool calls.
pub(crate) async fn running_client(state: &AppState, id: &str) -> AppResult<Arc<McpClient>> {
    state
        .connectors
        .lock()
        .await
        .get(id)
        .map(|(_, client)| client.clone())
        .ok_or_else(|| AppError::NotFound("connector isn't running; reconnect it in Customize → Connectors".into()))
}

/// The card's cart commands only ever reach Instamart's own server.
async fn ensure_instamart(state: &AppState, id: &str) -> AppResult<()> {
    let is_instamart = state.connectors.lock().await.get(id).is_some_and(|(spec, _)| {
        matches!(spec, ServerSpec::Http(remote) if remote.url.trim_end_matches('/').ends_with(".swiggy.com/im"))
    });
    if is_instamart {
        Ok(())
    } else {
        Err(AppError::Invalid("This connector isn't Instamart.".into()))
    }
}

async fn instamart_tool(state: &AppState, id: String, tool: &str, arguments: Value) -> AppResult<String> {
    ensure_instamart(state, &id).await?;
    let out = call(state, id, tool.to_string(), arguments, None).await?;
    if out.is_error {
        return Err(AppError::Invalid(if out.text.is_empty() { "Instamart couldn't update the cart.".into() } else { out.text }));
    }
    Ok(out.text)
}

/// One line of an Instamart cart, as `update_cart` takes it.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstamartLine {
    spin_id: String,
    sku_id: String,
    quantity: u32,
}

/// The cart as Instamart has it, for the card to merge a change into.
#[tauri::command]
pub async fn instamart_cart_read(state: State<'_, AppState>, id: String) -> AppResult<String> {
    instamart_tool(&state, id, "get_cart", serde_json::json!({})).await
}

/// Save the user's own change from the card, without a model turn. This never places an order:
/// only `get_cart`, `update_cart` and `clear_cart` are reachable from here.
#[tauri::command]
pub async fn instamart_cart_write(state: State<'_, AppState>, id: String, items: Vec<InstamartLine>, address_id: Option<String>) -> AppResult<String> {
    if items.is_empty() {
        return instamart_tool(&state, id, "clear_cart", serde_json::json!({})).await;
    }
    let address_id = address_id.ok_or_else(|| AppError::Invalid("Instamart needs a delivery address first. Ask the assistant to pick one.".into()))?;
    instamart_tool(&state, id, "update_cart", serde_json::json!({ "items": items, "selectedAddressId": address_id })).await
}

#[tauri::command]
pub async fn connector_disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.connectors.lock().await.remove(&id);
    Ok(())
}

/// Disconnect and delete stored credentials: for sign-out and deleted connectors.
#[tauri::command]
pub async fn connector_forget(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.connectors.lock().await.remove(&id);
    connector_auth::forget(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instamart_display_instructions_are_replaced_and_the_fields_kept() {
        let out = instamart_for_model("instamart__update_cart", "update_cart", "Please display the updated cart in a tabular format\n\n{\"items\":[]}".into());
        assert!(!out.contains("tabular"));
        assert!(out.starts_with(SHOWN_AS_CARD));
        assert!(out.ends_with("{\"items\":[]}"));
    }

    #[test]
    fn instamart_cart_keeps_prices_for_the_card_alone() {
        let text = "Please display a table\n\n{\"cartTotalAmount\":\"₹10\",\"selectedAddress\":\"a1\",\"billBreakdown\":{\"toPay\":{\"value\":\"₹10\"}},\"items\":[{\"spinId\":\"s\",\"skuId\":\"k\",\"itemName\":\"Tea\",\"quantity\":2,\"mrp\":9,\"discountedFinalPrice\":5,\"imageUrl\":\"u\"}]}";
        let out = instamart_output("instamart__get_cart", "get_cart", text.into());
        assert!(out["note"].as_str().unwrap().starts_with(SHOWN_AS_CARD));
        let item = &out["cart"]["items"][0];
        assert_eq!((&item["spinId"], &item["skuId"], &item["itemName"], &item["quantity"]), (&serde_json::json!("s"), &serde_json::json!("k"), &serde_json::json!("Tea"), &serde_json::json!(2)));
        assert!(item.get("discountedFinalPrice").is_none() && item.get("mrp").is_none());
        assert!(out["cart"].get("billBreakdown").is_none());
        assert_eq!(out["cart"]["cartTotalAmount"], "₹10");
        assert_eq!(out["cardOnly"]["result"]["items"][0]["discountedFinalPrice"], 5);
        assert_eq!(out["cardOnly"]["result"]["billBreakdown"]["toPay"]["value"], "₹10");
    }

    #[test]
    fn instamart_output_leaves_other_results_as_text() {
        assert_eq!(instamart_output("instamart__get_cart", "get_cart", "No cart here".into()), Value::String("No cart here".into()));
        assert!(instamart_output("instamart__search_products", "search_products", "Show\n\n{\"products\":[]}".into()).is_string());
        assert!(instamart_output("other__get_cart", "get_cart", "Show\n\n{\"items\":[]}".into()).is_string());
    }

    #[test]
    fn instamart_clear_keeps_swiggys_text_and_asks_for_a_read() {
        let out = instamart_for_model("instamart__clear_cart", "clear_cart", "Cart cleared successfully.".into());
        assert!(out.starts_with("Cart cleared successfully."));
        assert!(out.contains("call get_cart"));
    }

    #[test]
    fn instamart_addresses_keep_the_rows_and_drop_swiggys_instructions() {
        let text = "Found 2 saved addresses (page 1 of 1, showing 2):\n1. [Home] A B: 12 Main Road (ID: abc)\n2. [Work] A B: 3 Side Street (ID: def)\n\nThe saved addresses are ranked for display. Suggested/preselected address ID: abc Ask the user to confirm the suggestion or choose from address IDs: abc, def\n\nA rich UI widget may be shown.";
        let out = instamart_for_model("instamart__get_addresses", "get_addresses", text.into());
        assert!(out.contains("Found 2 saved addresses"));
        assert!(out.contains("1. [Home] A B: 12 Main Road (ID: abc)"));
        assert!(out.contains("2. [Work] A B: 3 Side Street (ID: def)"));
        assert!(out.ends_with("Suggested address ID: abc"));
        assert!(!out.contains("confirm the suggestion"));
        assert!(!out.contains("widget"));
    }

    #[test]
    fn instamart_addresses_stay_as_they_came_without_rows() {
        let text = "You have no saved addresses.".to_string();
        assert_eq!(instamart_for_model("instamart__get_addresses", "get_addresses", text.clone()), text);
    }

    #[test]
    fn instamart_search_says_the_card_can_add_items() {
        let out = instamart_for_model("instamart__search_products", "search_products", "Show a table\n\n{\"products\":[]}".into());
        assert!(out.contains("without sending a message"));
    }

    #[test]
    fn other_results_stay_as_they_came() {
        let cart = "Show a table\n\n{\"items\":[]}".to_string();
        assert_eq!(instamart_for_model("other__update_cart", "update_cart", cart.clone()), cart);
        assert_eq!(instamart_for_model("instamart__get_orders", "get_orders", cart.clone()), cart);
        // Plain text, or braces that aren't the result's JSON.
        let text = "Show a {table} of this".to_string();
        assert_eq!(instamart_for_model("instamart__get_cart", "get_cart", text.clone()), text);
    }
}
