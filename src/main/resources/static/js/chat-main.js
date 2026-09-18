/* =============================================================================
 * 1. CONFIGURATION
 * ========================================================================== */

// Base address of the Spring Boot backend. Change this one line when deploying.
const API_BASE = 'http://localhost:8080';

// How many messages one history request loads.
const PAGE_SIZE = 10;

/**
 * A message is considered "read" once this much of it is visible.
 * 0.5 means half of the message.
 */
const READ_VISIBILITY_RATIO = 0.5;

/**
 * How close to the bottom the message area still counts as "following the
 * conversation", in pixels. A few pixels of slack absorbs rounding and the
 * bounce of a smooth scroll.
 */
const BOTTOM_PROXIMITY_PX = 40;

/**
 * Minimum gap between two "user is typing" signals, in milliseconds.
 * Without this we would send one WebSocket frame per key press.
 * It is deliberately below TYPING_INDICATOR_HIDE_MS so the indicator on the
 * other side never flickers off while the user is still typing.
 */
const TYPING_SIGNAL_INTERVAL_MS = 1500;

/** How long the "... is typing" indicator stays on screen after the last signal. */
const TYPING_INDICATOR_HIDE_MS = 2000;


/* =============================================================================
 * 2. STATE
 * These are like the fields of a class: they describe what the page is currently showing.
 * ========================================================================== */

/** The STOMP client. Stays null until connect() succeeds. */
let stompClient = null;

/** Id of the logged-in user, saved by login.js. */
let currentProfileId = null;

/** Id of the chat currently open on the right side (null = nothing open). */
let selectedChatId = null;

/** Type of the open chat: 'CHAT' (one to one) or 'GROUP'. */
let selectedChatType = null;

/** The chat list as returned by the server. Used to fill the chat header. */
let chatList = [];

/** Set while editing an existing message; null while writing a new one. */
let selectedMessageId = null;

/** Set while replying to a message; null otherwise. */
let repliedMessageId = null;

/** true when a scroll check is already scheduled for the next animation frame. */
let isScrollCheckScheduled = false;

/** Timestamp of the last "user is typing" signal we sent. */
let lastTypingSentAt = 0;

/** Handle of the timer that hides the typing indicator. */
let typingIndicatorTimer = null;

/** true right after a chat is opened, so we know to scroll to the last read message. */
let isChatJustOpened = true;

/** true while a history request is in flight — stops duplicate requests. */
let isLoadingHistory = false;

/**
 * Describes the last history request we sent, e.g. "chat7|UP|2026-07-30T10:00".
 * Stops us asking the server for the very same page twice in a row.
 */
let lastRequestedCursor = null;

/** Watches messages on screen and marks them as read. Created at startup. */
let unreadMessageObserver = null;

/* =============================================================================
 * 3. DOM REFERENCES
 * Looked up once here instead of calling getElementById() over and over.
 * ========================================================================== */

// Left sidebar
const chatListContainer = document.getElementById('chatListContainerId');

// Chat header
const chatNameDiv = document.getElementById('chatNameDivId');
const chatStatusDiv = document.getElementById('chatOnlineMembersCountDivId');
const typingIndicator = document.getElementById('typingIndicatorId');
const typingUserSpan = document.getElementById('typingUserSpanId');

// Message area
const chatMessageContainer = document.getElementById('chatMessageContainerId');

// Message input
const messageInput = document.getElementById('inputMessageId');
const inputMessageClearIcon = document.getElementById('inputMessageClearIconId');

// Attachment preview modal
const imagePreviewModalOverlay = document.getElementById('imagePreviewModalOverlayId');
const imagePreviewModalImg = document.getElementById('imagePreviewModalImgId');
const imagePreviewModalInput = document.getElementById('imagePreviewModalInputId');


/* =============================================================================
 * 4. STARTUP
 * ========================================================================== */

/**
 * Runs once the HTML is ready.
 *
 * Order matters: all listeners are registered BEFORE connecting to the
 * WebSocket. If the connection fails, the page still works for everything
 * that does not need it.
 */
window.addEventListener('DOMContentLoaded', async () => {
    currentProfileId = localStorage.getItem('id');

    registerEventListeners();
    unreadMessageObserver = createUnreadMessageObserver();

    try {
        await connectWebSocket();
        console.log('WebSocket connection established');
    } catch (error) {
        console.error('Could not connect to the chat server:', error);
        chatStatusDiv.innerText = 'connection failed';
    }

    // load chat history
    loadChatList();
});

/** Attaches every event listener the page needs. */
function registerEventListeners() {
    // Typing in the message box: Enter sends, other keys signal "typing".
    messageInput.addEventListener('keydown', onMessageInputKeydown);

    // One listener for the whole sidebar instead of one per chat item.
    // (The sidebar is re-rendered often; a listener per item would pile up.)
    chatListContainer.addEventListener('click', onChatListClick);

    // Scrolling the message area loads more history.
    // `passive: true` tells the browser we never call preventDefault(),
    // which lets it keep scrolling smoothly.
    chatMessageContainer.addEventListener('scroll', onChatScroll, {passive: true});

    // Clicking anywhere closes any open tooltip.
    document.addEventListener('click', closeAllTooltips);


}

/* =============================================================================
 * 5. HTTP LAYER
 * ========================================================================== */

/**
 * Returns the saved JWT, or sends the user to the login page and returns null.
 *
 * IMPORTANT: assigning `window.location` does NOT stop the current function,
 * so every caller must `return` when this returns null.
 *
 * @returns {string|null} the token, or null when the user is not logged in
 */
function requireJwt() {
    const jwt = localStorage.getItem('jwtToken');
    if (!jwt) {
        window.location.href = './login.html';
        return null;
    }
    return jwt;
}

/**
 * Single entry point for every REST call. Adds the Authorization header,
 * checks the HTTP status and parses the JSON response.
 *
 * @param {string} path    path after API_BASE, e.g. '/api/v1/chat-message'
 * @param {object} options fetch options: method, body, ...
 * @returns {Promise<any>} the parsed response body, or null if not logged in
 * @throws  {Error}        when the server answers with a non-2xx status
 */
async function apiRequest(path, options = {}) {
    const jwt = requireJwt();
    if (!jwt) {
        return null;
    }

    const headers = {'Authorization': 'Bearer ' + jwt};
    // FormData builds its own Content-Type (it contains a random boundary),
    // so we only set it ourselves for normal JSON bodies.
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(API_BASE + path, {...options, headers});

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Request failed (${response.status}): ${errorText}`);
    }
    // 204 No Content has an empty body, so there is nothing to parse.
    if (response.status === 204) {
        return null;
    }
    return response.json();
}


/* =============================================================================
 * 6. WEBSOCKET LAYER
 * ========================================================================== */

/**
 * Opens the WebSocket connection.
 *
 * The STOMP library uses callbacks, so we wrap it in a Promise to be able to
 * `await` it in the startup function.
 *
 * @returns {Promise<void>} resolves when connected, rejects when it fails
 */
function connectWebSocket() {
    const jwt = requireJwt();
    if (!jwt) {
        return Promise.resolve();
    }

    const socket = new SockJS(`${API_BASE}/ws`);
    stompClient = Stomp.over(socket);

    return new Promise((resolve, reject) => {
        stompClient.connect(
            {Authorization: 'Bearer ' + jwt},
            () => resolve(),
            (error) => reject(error)
        );
    });
}

/** @returns {boolean} true when messages can be sent over the WebSocket. */
function isSocketConnected() {
    return stompClient !== null && stompClient.connected;
}

/**
 * Subscribes to the three private queues of the logged-in user.
 * These carry events from one-to-one chats.
 */
function subscribeToUserQueues() {
    stompClient.subscribe('/user/queue/getChatUpdate/', (frame) => {
        const messageDto = JSON.parse(frame.body);
        onChatUpdateReceived(messageDto.senderId, messageDto);
    });

    // chatMessageRead
    stompClient.subscribe('/user/queue/chatMessageRead/', (frame) => {
        onMessageReadReceived(JSON.parse(frame.body));
    });

    // userTyping
    stompClient.subscribe('/user/queue/userTyping/', (frame) => {
        console.log('userTyping');
        onUserTypingReceived(JSON.parse(frame.body));
    });
}

/**
 * Handles a new / edited / deleted message arriving over the WebSocket.
 *
 * @param {string} chatId     the chat the event belongs to
 * @param {object} messageDto the message payload
 */
function onChatUpdateReceived(chatId, messageDto) {
    // The chat is not open: only bump the unread badge in the sidebar.
    if (selectedChatId !== chatId) {
        increaseUnreadMessageCount(chatId, messageDto);
        return;
    }
    // The chat is open but older unread messages are still waiting above,
    // so keep counting instead of appending out of order.
    const chatItem = document.getElementById(chatId);
    const unreadBadge = chatItem ? chatItem.querySelector('.chat-unread') : null;
    if (unreadBadge && Number(unreadBadge.textContent) > 0) {
        increaseUnreadMessageCount(chatId, messageDto);
        return;
    }

    switch (messageDto.socketMessageType) {
        case 'NewMessage': {
            // Measure before inserting: appending grows scrollHeight.
            const wasFollowingConversation = isScrolledToBottom();

            renderMessages([messageDto], 'beforeend');

            if (wasFollowingConversation) {
                // The user is at the newest message, so show the arrival.
                scrollToBottom();
            } else {
                // The user is reading further up. The message is on the page
                // but off screen, so it counts as unread until it is seen --
                // the observer takes the badge back down at that point.
                increaseUnreadMessageCount(chatId, messageDto);
            }

            observeUnreadMessages();
            break;
        }
        case 'UpdateMessage':
            updateMessageContent(messageDto);
            break;
        case 'DeleteMessage':
            removeMessageFromScreen(messageDto.id);
            break;
        default:
            console.warn('Unknown socketMessageType:', messageDto.socketMessageType);
    }
}

/**
 * The other side read one of our messages: turn the single tick into a double tick.
 *
 * @param {object} messageDto contains the id of the message that was read
 */
function onMessageReadReceived(messageDto) {
    const messageElement = document.getElementById(messageDto.id);
    if (!messageElement) {
        return;
    }
    messageElement.classList.replace('unread', 'read');

    const icon = messageElement.querySelector('.fa-check');
    if (icon) {
        icon.classList.replace('fa-check', 'fa-check-double');
    }
}

/* =============================================================================
 * 7. CHAT LIST (left sidebar)
 * ========================================================================== */

/** Loads the chat list from the server, draws it and subscribes to its topics. */
async function loadChatList() {
    try {
        const page = await apiRequest(`/api/v1/chat?page=1&size=100`);
        if (!page) {
            return;
        }

        chatList = page.content;
        renderChatList(chatList);

        if (isSocketConnected()) {
            subscribeToUserQueues();
        }
    } catch (error) {
        console.error('Could not load the chat list:', error);
    }
}

/**
 * Draws the sidebar. Replaces the whole list at once, which is faster than
 * inserting the items one by one.
 *
 * @param {Array} chats chats to show
 */
function renderChatList(chats) {
    chatListContainer.innerHTML = chats.map(chat => {
        const photoUrl = chat.photo?.url || './img/user-def.jpg';
        const lastMessage = chat.message || {};

        return `
            <div class="chat-item" id="${chat.id}"
                 data-chat-type="${chat.chatType}"
                 data-is-group-member="${chat.isGroupMember}">
                <div class="chat-avatar">
                    <img src="${photoUrl}" alt="">
                </div>
                <div class="chat-info">
                    <div class="chat-name">${chat.name}</div>
                    ${lastMessage.content
            ? `<div class="chat-last-message">${lastMessage.content}</div>`
            : ''}
                </div>
                <div class="chat-meta">
                    ${lastMessage.content
            ? `<div class="chat-time">${formatDateTime(lastMessage.createdDate)}</div>`
            : ''}
                    ${chat.unreadMessageCount
            ? `<div class="chat-unread">${chat.unreadMessageCount}</div>`
            : ''}
                </div>
            </div>`;
    }).join('');
}

/**
 * Handles a click anywhere in the sidebar.
 *
 * This is "event delegation": one listener on the container works for every
 * chat item, including items added later.
 *
 * @param {MouseEvent} event
 */
function onChatListClick(event) {
    const chatItem = event.target.closest('.chat-item');
    if (!chatItem) {
        return;
    }

    selectChat(chatItem.id, chatItem.dataset.chatType);
    //is user joined the group
    openChat(chatItem.id);
}


/**
 * Increases the unread badge of a chat and updates its last-message preview.
 *
 * @param {string} chatId
 * @param {object} messageDto the message that arrived
 */
function increaseUnreadMessageCount(chatId, messageDto) {
    const chatItem = document.getElementById(chatId);
    if (!chatItem) {
        return;
    }

    const lastMessagePreview = chatItem.querySelector('.chat-last-message');
    if (lastMessagePreview) {
        lastMessagePreview.textContent = messageDto.content;
    }

    const chatMeta = chatItem.querySelector('.chat-meta');
    if (!chatMeta) {
        return;
    }

    const unreadBadge = chatMeta.querySelector('.chat-unread');
    const newCount = unreadBadge ? Number(unreadBadge.textContent) + 1 : 1;

    chatMeta.innerHTML = `
        <div class="chat-time">${formatDateTime(messageDto.createdDate)}</div>
        <div class="chat-unread">${newCount}</div>`;
}

/**
 * Decreases the unread badge of a chat by one, removing it when it hits zero.
 *
 * @param {string} chatId
 */
function decreaseUnreadMessageCount(chatId) {
    const chatItem = chatId ? document.getElementById(chatId) : null;
    if (!chatItem) {
        return;
    }

    const unreadBadge = chatItem.querySelector('.chat-unread');
    if (!unreadBadge) {
        return;
    }

    const newCount = Number(unreadBadge.textContent) - 1;
    if (newCount > 0) {
        unreadBadge.textContent = String(newCount);
    } else {
        unreadBadge.remove();
    }
}


/* =============================================================================
 * 8. OPENING A CHAT
 * ========================================================================== */

/**
 * Marks a chat as the selected one and resets everything tied to the previous chat.
 *
 * @param {string} chatId
 * @param {string} chatType 'CHAT' or 'GROUP'
 */
function selectChat(chatId, chatType) {
    selectedChatId = chatId;
    selectedChatType = chatType;

    // Reset the scroll pagination state of the previous chat.
    lastRequestedCursor = null;
    isLoadingHistory = false;
    isChatJustOpened = true;

    // Move the 'active' highlight to the clicked item.
    document.querySelectorAll('.chat-item.active')
        .forEach(item => item.classList.remove('active'));
    const selectedItem = document.getElementById(chatId);
    if (selectedItem) {
        selectedItem.classList.add('active');
    }

    clearInput();
    messageInput.focus();
    showChatHeader();
}

/** Puts the name and type of the selected chat into the header. */
function showChatHeader() {
    const chat = chatList.find(item => item.id === selectedChatId);
    if (!chat) {
        return;
    }
    chatNameDiv.innerText = chat.name;
    chatStatusDiv.innerText = 'online';
}

/**
 * Clears the message area and loads the newest messages of a chat.
 *
 * @param {string} chatId
 */
async function openChat(chatId) {
    chatMessageContainer.innerHTML = '';
    try {
        const messages = await loadMessageHistory(chatId, true, 'DOWN');

        // A single short page may not fill the screen, and without a scrollbar
        // the user can never trigger the next page. Load one more in that case.
        const isPartiallyFilled = messages && messages.length > 0 && messages.length < PAGE_SIZE * 2;
        if (isPartiallyFilled) {
            const oldestLoaded = messages[messages.length - 1];
            await loadMessageHistory(chatId, false, 'DOWN', oldestLoaded.createdDate, 'beforeend');
        }
    } catch (error) {
        console.error('Could not open the chat:', error);
    }

}

/* =============================================================================
 * 9. MESSAGE HISTORY AND INFINITE SCROLL
 * ========================================================================== */

/**
 * Asks the server for a page of messages and puts them on screen.
 *
 * The server pages by cursor, not by page number: `lmCreatedDate` is the
 * timestamp of the message we already have at that edge of the list.
 *
 * @param {string}  chatId
 * @param {boolean} justChatOpened  true for the very first page of a chat
 * @param {string}  scrollDirection 'UP' for older messages, 'DOWN' for newer
 * @param {string}  lmCreatedDate   timestamp to continue from (null for the first page)
 * @param {string}  insertPosition  'afterbegin' (on top) or 'beforeend' (at the bottom)
 * @returns {Promise<Array>} the messages that were loaded
 */
async function loadMessageHistory(chatId, justChatOpened = false, scrollDirection = 'UP',
                                  lmCreatedDate = null, insertPosition = 'beforeend') {
    const query = new URLSearchParams({
        scrollDirection: scrollDirection,
        justChatOpened: justChatOpened,
        size: PAGE_SIZE
    });

    const messages = await apiRequest(`/api/v1/chat-message/${chatId}?${query}`, {
        method: 'POST',
        body: JSON.stringify({lmCreatedDate: lmCreatedDate})
    });

    if (!messages) {
        return [];
    }

    // The server returns older messages newest-first; flip them so that
    // inserting with 'afterbegin' keeps the chronological order.
    if (scrollDirection === 'UP') {
        messages.reverse();
    }

    renderMessages(messages, insertPosition);

    // renderMessages() fixes the scroll position on the next animation frame,
    // so anything that depends on the final position has to wait for it.
    requestAnimationFrame(() => {
        if (isChatJustOpened) {
            isChatJustOpened = false;
            scrollToLastReadMessage();
        }
        observeUnreadMessages();
    });

    return messages;
}

/**
 * Called on every scroll event.
 *
 * Scrolling fires far more often than we could ever load a page, so the real
 * work is postponed to the next animation frame and repeated events are dropped.
 */
function onChatScroll() {
    if (isScrollCheckScheduled) {
        return;
    }
    isScrollCheckScheduled = true;

    requestAnimationFrame(() => {
        isScrollCheckScheduled = false;
        loadMoreMessagesIfNeeded();
    });
}

/** Loads the next page when the user has scrolled to the top or the bottom. */
async function loadMoreMessagesIfNeeded() {
    if (isLoadingHistory || !selectedChatId) {
        return;
    }

    const firstMessage = chatMessageContainer.firstElementChild;
    const lastMessage = chatMessageContainer.lastElementChild;
    if (!firstMessage || !lastMessage) {
        return;
    }

    // Only one direction can win. In a short chat both the first and the last
    // message are visible at the same time, and checking them independently
    // would always end up loading downwards.
    let scrollDirection;
    let anchorMessage;
    if (isElementFullyVisible(firstMessage)) {
        scrollDirection = 'UP';
        anchorMessage = firstMessage;
    } else if (isElementFullyVisible(lastMessage)) {
        scrollDirection = 'DOWN';
        anchorMessage = lastMessage;
    } else {
        return; // the user is somewhere in the middle
    }

    const lmCreatedDate = anchorMessage.dataset.createddate;

    // Do not ask for the exact same page twice. This is kept in a variable
    // rather than on the element so that a failed request can be retried.
    const cursor = `${selectedChatId}|${scrollDirection}|${lmCreatedDate}`;
    if (cursor === lastRequestedCursor) {
        return;
    }

    isLoadingHistory = true;
    lastRequestedCursor = cursor;
    try {
        await loadMessageHistory(selectedChatId, false, scrollDirection, lmCreatedDate,
            scrollDirection === 'UP' ? 'afterbegin' : 'beforeend');
    } catch (error) {
        console.error('Could not load more messages:', error);
        lastRequestedCursor = null; // let the next scroll try again
    } finally {
        // Must always run: if this stayed true, scrolling would never load again.
        isLoadingHistory = false;
    }
}

/**
 * @param {Element} element
 * @returns {boolean} true when the element fits completely inside the message area
 */
function isElementFullyVisible(element) {
    const elementBox = element.getBoundingClientRect();
    const containerBox = chatMessageContainer.getBoundingClientRect();
    return elementBox.top >= containerBox.top && elementBox.bottom <= containerBox.bottom;
}

/* =============================================================================
 * 10. RENDERING MESSAGES
 * ========================================================================== */

/**
 * Adds messages to the screen while keeping the scroll position steady.
 *
 * When older messages are inserted on top, the content below moves down.
 * Without the correction the view would jump.
 *
 * @param {Array}  messages
 * @param {string} position 'afterbegin' or 'beforeend'
 */
function renderMessages(messages, position = 'beforeend') {
    const previousScrollHeight = chatMessageContainer.scrollHeight;
    const previousScrollTop = chatMessageContainer.scrollTop;

    messages.forEach(message => appendMessage(message, position));

    // Only inserting on top shifts the existing content down. Appending at the
    // end leaves every message where it was, so there is nothing to correct --
    // and writing scrollTop back would undo a scrollToBottom() made by the caller.
    if (position !== 'afterbegin') {
        return;
    }

    requestAnimationFrame(() => {
        const addedHeight = chatMessageContainer.scrollHeight - previousScrollHeight;
        chatMessageContainer.scrollTop = previousScrollTop + addedHeight;
    });
}

/**
 * Builds the HTML of one message and inserts it into the message area.
 *
 * @param {object} message
 * @param {string} position 'afterbegin' or 'beforeend'
 */
function appendMessage(message, position = 'beforeend') {
    const isOwnMessage = message.senderId === currentProfileId;
    const sender = message.sender || {};

    // Show the avatar and the sender name only for other people in a group.
    const showSenderInfo = selectedChatType === 'GROUP' && !isOwnMessage;

    const html = `
        <div class="message-wrapper ${message.isReceiverRead ? 'read' : 'unread'}"
             id="${message.id}"
             data-message-id="${message.id}"
             data-createdDate="${message.createdDate}"
             data-sender-id="${message.senderId}"
             data-chat-id="${selectedChatId}">

            ${showSenderInfo ? `
                <div class="chat-avatar">
                    <img src="${sender.photo ? sender.photo.url : './img/brain.png'}" alt="">
                </div>` : ''}

            <div class="message ${isOwnMessage ? 'message-right' : 'message-left'}">
                ${showSenderInfo ? `
                    <div class="message-sender-data">
                        <div class="message-sender-name">${escapeHtml(sender.name || '')}</div>
                    </div>` : ''}

                ${message.repliedMessage ? `
                    <div class="reply-message-preview">
                        ${escapeHtml(message.repliedMessage.content)}
                    </div>` : ''}

                <div class="message-text-data-container">
                    ${renderMessageBody(message)}
                    ${isOwnMessage ? `
                        <div onclick="openToolTip(event)"><i class="fas fa-ellipsis-v"></i></div>
                        <div class="tooltip">
                            <div class="tooltip-option" onclick="editMessage('${message.id}')">
                                <i class="fa fa-pencil" aria-hidden="true"></i>Edit
                            </div>
                            <div class="tooltip-option" onclick="deleteMessage('${message.id}')">
                                <i class="fa fa-trash" aria-hidden="true"></i>Delete
                            </div>
                            <div class="tooltip-option" onclick="replyToMessage('${message.id}')">
                                <i class="fa fa-reply" aria-hidden="true"></i>Reply
                            </div>
                        </div>` : ''}
                </div>

                <div class="message-text-date-container">
                    <div class="message-time">${formatDateTime(message.createdDate)}</div>
                    ${isOwnMessage
        ? `<div><i class="fas ${message.isReceiverRead ? 'fa-check-double' : 'fa-check'}"></i></div>`
        : ''}
                </div>
            </div>
        </div>`;

    chatMessageContainer.insertAdjacentHTML(position, html);
}

/**
 * Builds the inner part of a message, which depends on its type.
 *
 * @param {object} message
 * @returns {string} HTML
 */
function renderMessageBody(message) {
    const caption = message.capture ? `<div>${escapeHtml(message.capture)}</div>` : '';
    const attachUrl = message.attach ? message.attach.url : '';

    switch (message.chatMessageType) {
        case 'TEXT':
            return `<div id="${message.id}-content">${escapeHtml(message.content)}</div>`;

        case 'PHOTO':
            return `<div>
                        <div class="message-image-container"><img src="${attachUrl}" alt=""></div>
                        ${caption}
                    </div>`;

        case 'VIDEO':
            return `<div>
                        <video controls>
                            <source src="${attachUrl}" type="video/mp4">
                            Your browser does not support the video tag.
                        </video>
                        ${caption}
                    </div>`;

        case 'AUDIO':
            return `<div>
                        <audio controls>
                            <source src="${attachUrl}">
                            Your browser does not support the audio tag.
                        </audio>
                        ${caption}
                    </div>`;

        case 'FILE':
            return `<div>
                        <a href="${attachUrl}" target="_blank">
                            <i class="fa-solid fa-file"></i>
                        </a>
                        ${caption}
                    </div>`;

        default:
            return '';
    }
}

/**
 * Replaces the text of a message that was edited.
 *
 * @param {object} message must contain id and content
 */
function updateMessageContent(message) {
    const contentElement = document.getElementById(message.id + '-content');
    if (contentElement) {
        contentElement.innerText = message.content;
    }
}

/**
 * Removes a message from the screen.
 *
 * @param {string} messageId
 */
function removeMessageFromScreen(messageId) {
    const element = document.getElementById(messageId);
    if (element) {
        element.remove();
    }
}

/** Scrolls to the bottom of the message area. */
function scrollToBottom() {
    chatMessageContainer.scrollTop = chatMessageContainer.scrollHeight;
}

/**
 * @returns {boolean} true when the newest message is on screen
 *
 * Call this BEFORE inserting a message: appending changes scrollHeight, which
 * would make an up-to-date view look scrolled away from the bottom.
 */
function isScrolledToBottom() {
    const distanceFromBottom = chatMessageContainer.scrollHeight
        - chatMessageContainer.scrollTop
        - chatMessageContainer.clientHeight;
    return distanceFromBottom <= BOTTOM_PROXIMITY_PX;
}

/** Scrolls to the newest message the user has already read. */
function scrollToLastReadMessage() {
    const readMessages = chatMessageContainer.querySelectorAll('.read');
    if (readMessages.length === 0) {
        scrollToBottom();
        return;
    }
    readMessages[readMessages.length - 1].scrollIntoView({behavior: 'auto', block: 'end'});
}


/* =============================================================================
 * 11. SENDING MESSAGES
 * ========================================================================== */

/**
 * Reacts to a key press in the message box.
 *
 * @param {KeyboardEvent} event
 */
function onMessageInputKeydown(event) {
    console.log("onMessageInputKeydown");
    // Enter sends the message; Shift+Enter is left alone for a line break.
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
        return;
    }
    if (isTextKey(event)) {
        sendTypingSignal();
    }
}

/**
 * @param {KeyboardEvent} event
 * @returns {boolean} true when the key actually changes the text
 *
 * Without this check, Shift, Ctrl, Tab and the arrow keys would each send a
 * "user is typing" signal.
 */
function isTextKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
        return false;
    }
    return event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete';
}

/**
 * Sends the text in the input box, either as a new message or as an edit of
 * the message the user picked with "Edit".
 */
async function sendMessage() {
    const content = messageInput.value.trim();
    if (!content || !selectedChatId) {
        return;
    }

    // Remember what we are doing before clearInput() resets the state.
    const editingMessageId = selectedMessageId;

    const chatMessage = {
        receiverId: selectedChatId,
        content: content,
        repliedMessageId: repliedMessageId,
        chatMessageType: 'TEXT'
    };
    console.log(chatMessage);
    clearInput();

    try {
        if (editingMessageId) {
            await apiRequest(`/api/v1/chat-message/${editingMessageId}`, {
                method: 'PUT',
                body: JSON.stringify(chatMessage)
            });
            updateMessageContent({id: editingMessageId, content: content});
        } else {
            const savedMessage = await apiRequest('/api/v1/chat-message', {
                method: 'POST',
                body: JSON.stringify(chatMessage)
            });
            if (savedMessage) {
                renderMessages([savedMessage], 'beforeend');
                scrollToBottom();
            }
        }
    } catch (error) {
        console.error('Could not send the message:', error);
        alert('Message was not sent. Please try again.');
    }
}

/**
 * Deletes a message after asking the user to confirm.
 * Called from the tooltip in the message HTML.
 *
 * @param {string} messageId
 */
async function deleteMessage(messageId) {
    if (!confirm('Do you want to delete this message?')) {
        return;
    }
    try {
        await apiRequest(`/api/v1/chat-message/${messageId}`, {method: 'DELETE'});
        removeMessageFromScreen(messageId);
    } catch (error) {
        console.error('Could not delete the message:', error);
    }
}

/**
 * Loads a message into the input box so the user can change it.
 * Called from the tooltip in the message HTML.
 *
 * @param {string} messageId
 */
function editMessage(messageId) {
    const contentElement = document.getElementById(messageId + '-content');
    if (!contentElement) {
        return; // only text messages can be edited
    }
    selectedMessageId = messageId;
    messageInput.value = contentElement.innerText;
    messageInput.classList.add('input-field-with-icon');
    messageInput.focus();
    showInputMessageClearIcon();
}


/**
 * Marks a message as the one being replied to.
 * Called from the tooltip in the message HTML.
 *
 * @param {string} messageId
 */
function replyToMessage(messageId) {
    repliedMessageId = messageId;
    messageInput.classList.add('input-field-with-icon');
    messageInput.focus();
    showInputMessageClearIcon();
}

/** Empties the input box and cancels any pending edit or reply. */
function clearInput() {
    messageInput.value = '';
    selectedMessageId = null;
    repliedMessageId = null;
    hideInputMessageClearIcon();
}

function showInputMessageClearIcon() {
    inputMessageClearIcon.classList.remove('display-non');
}

function hideInputMessageClearIcon() {
    inputMessageClearIcon.classList.add('display-non');
    messageInput.classList.remove('input-field-with-icon');
}


/* =============================================================================
 * 12. READ RECEIPTS
 * ========================================================================== */

/**
 * Creates the observer that marks messages as read.
 *
 * An IntersectionObserver is the browser's built-in way of being told when an
 * element becomes visible. It is far cheaper than checking positions on every
 * scroll event.
 *
 * @returns {IntersectionObserver}
 */
function createUnreadMessageObserver() {
    return new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting || !isVisibleEnoughToBeRead(entry)) {
                return;
            }

            const messageElement = entry.target;
            observer.unobserve(messageElement); // each message is reported once

            // Our own messages are read by the other side, not by us.
            if (messageElement.dataset.senderId === currentProfileId) {
                return;
            }

            messageElement.classList.remove('unread');
            markMessageAsRead(messageElement.dataset.messageId);

            // Use the chat the message belongs to, not selectedChatId: the user
            // may already have switched chats by the time this runs.
            decreaseUnreadMessageCount(messageElement.dataset.chatId);
        });
    }, {
        root: chatMessageContainer,
        threshold: [0, READ_VISIBILITY_RATIO]
    });
}

/**
 * @param {IntersectionObserverEntry} entry
 * @returns {boolean} true when enough of the message is on screen
 *
 * A message taller than the message area can never reach the 50% ratio, so a
 * message that fills half of the visible area counts as read too.
 */
function isVisibleEnoughToBeRead(entry) {
    if (entry.intersectionRatio >= READ_VISIBILITY_RATIO) {
        return true;
    }
    const containerHeight = entry.rootBounds ? entry.rootBounds.height : 0;
    return containerHeight > 0
        && entry.intersectionRect.height >= containerHeight * READ_VISIBILITY_RATIO;
}

/** Starts watching every message on screen that is still unread. */
function observeUnreadMessages() {
    if (!unreadMessageObserver) {
        return;
    }
    chatMessageContainer.querySelectorAll('.unread')
        .forEach(message => unreadMessageObserver.observe(message));
}

/**
 * Tells the server that a message has been read.
 *
 * @param {string} messageId
 */
function markMessageAsRead(messageId) {
    if (!isSocketConnected()) {
        return;
    }
    stompClient.send('/app/v1/chat.markMessageAsRead', {}, JSON.stringify({messageId: messageId}));
}

/* =============================================================================
 * 13. TYPING INDICATOR
 * ========================================================================== */

/**
 * Tells the other side that the user is typing.
 * Sends at most one signal per TYPING_SIGNAL_INTERVAL_MS.
 */
function sendTypingSignal() {
    if (!selectedChatId || !isSocketConnected()) {
        return;
    }

    const now = performance.now();
    if (now - lastTypingSentAt < TYPING_SIGNAL_INTERVAL_MS) {
        return;
    }
    lastTypingSentAt = now;
    console.log(' selectedChatId: ', selectedChatId);
    stompClient.send(`/app/v1/chat.userTyping.${selectedChatId}`, {}, null);
}

/**
 * Shows "<name> is typing..." and hides it again after a short pause.
 *
 * @param {object} messageDto contains senderId and name
 */
function onUserTypingReceived(messageDto) {
    if (messageDto.typingChatId === currentProfileId) {
        return;
    }

    typingUserSpan.innerText = `${messageDto.name} is typing...`;
    typingIndicator.style.display = 'flex';

    // Restart the timer on every signal, so the text stays while typing continues.
    clearTimeout(typingIndicatorTimer);
    typingIndicatorTimer = setTimeout(() => {
        typingIndicator.style.display = 'none';
    }, TYPING_INDICATOR_HIDE_MS);
}


/* =============================================================================
 * 16. SMALL HELPERS
 * ========================================================================== */

/**
 * Opens or closes the tooltip next to a message.
 * Called from the message HTML.
 *
 * @param {MouseEvent} event
 */
function openToolTip(event) {
    const tooltip = event.currentTarget.nextElementSibling;
    tooltip.classList.toggle('show');
    // Stop the click here, otherwise the document listener closes it again.
    event.stopPropagation();
}


/** Closes every open tooltip on the page. */
function closeAllTooltips() {
    document.querySelectorAll('.tooltip.show')
        .forEach(tooltip => tooltip.classList.remove('show'));
}

/* =============================================================================
 * 20. SMALL UTIL/HELPERS
 * ========================================================================== */

/**
 * Formats an ISO timestamp as "yyyy-MM-dd HH:mm".
 *
 * @param {string} isoDateTime
 * @returns {string}
 */
function formatDateTime(isoDateTime) {
    if (!isoDateTime) {
        return '';
    }
    const date = new Date(isoDateTime);

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // months start at 0
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Escapes text before it is put into HTML.
 *
 * Message text comes from other users. Without escaping, someone could send
 * `<script>...</script>` and it would run in everyone's browser (XSS).
 *
 * @param {string} text
 * @returns {string} safe text
 */
function escapeHtml(text) {
    if (text === null || text === undefined) {
        return '';
    }
    // Assigning to textContent and reading back innerHTML lets the browser
    // do the escaping for us.
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

