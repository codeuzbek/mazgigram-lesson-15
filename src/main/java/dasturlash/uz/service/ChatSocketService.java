package dasturlash.uz.service;

import dasturlash.uz.config.CustomUserDetails;
import dasturlash.uz.dto.chat.ChatMessageDTO;
import dasturlash.uz.dto.chat.ChatTypingDTO;
import dasturlash.uz.entity.ChatMessageEntity;
import dasturlash.uz.entity.ProfileEntity;
import dasturlash.uz.enums.ChatType;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;

import java.security.Principal;


@Service
public class ChatSocketService {
    @Autowired
    private ProfileService profileService;
    @Autowired
    private SimpMessagingTemplate messagingTemplate;
    @Autowired
    private ChatMessageService chatMessageService;

    public void sendChatUpdateToUser(String email, ChatMessageDTO dto) {
        messagingTemplate.convertAndSendToUser(email, "/queue/getChatUpdate/", dto);
    }

    public void markMessageAsRead(String messageId, Principal principal) {
        // check
        ChatMessageEntity chatMessage = chatMessageService.getById(messageId);
        // set isReceiverRead = true
        chatMessageService.markMessageAsRead(chatMessage.getId());

        // GROUP

        // send notification
        ChatMessageDTO dto = new ChatMessageDTO();
        dto.setSenderId(chatMessage.getSenderId());
        dto.setId(messageId);
        ProfileEntity sender = profileService.getById(chatMessage.getSenderId());
        messagingTemplate.convertAndSendToUser(sender.getEmail(), "/queue/chatMessageRead/", dto);

    }

    public void userTyping(String chatId, Principal principal) {
        CustomUserDetails currentProfile = (CustomUserDetails) ((Authentication) principal).getPrincipal();
        ProfileEntity receiver = profileService.getById(chatId);
        messagingTemplate.convertAndSendToUser(receiver.getEmail(), "/queue/userTyping/", new ChatTypingDTO(currentProfile.getName(), currentProfile.getId()));
    }

}
