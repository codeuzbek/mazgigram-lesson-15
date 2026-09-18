package dasturlash.uz.controller;

import dasturlash.uz.dto.chat.ChatMessageReadDTO;
import dasturlash.uz.enums.ChatStatus;
import dasturlash.uz.enums.ChatType;
import dasturlash.uz.service.ChatMessageService;
import dasturlash.uz.service.ChatSocketService;
import dasturlash.uz.service.ProfileService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.handler.annotation.DestinationVariable;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.stereotype.Controller;

import java.security.Principal;

@Controller
public class ChatSocketController {

    @Autowired
    private ChatSocketService chatSocketService;
    @Autowired
    private ProfileService profileService;
    @Autowired
    private ChatMessageService chatMessageService;

    @MessageMapping("/chat.markMessageAsRead")
    public String markMessageAsRead(@Payload ChatMessageReadDTO dto, Principal principal) {
        System.out.println("markMessageAsRead");
        chatSocketService.markMessageAsRead(dto.getMessageId(), principal);
        return "DONE";
    }

    @MessageMapping("/chat.userTyping.{chatId}")
    public String userTyping(@DestinationVariable String chatId, Principal principal) {
        System.out.println("userTyping: "+ chatId);
        chatSocketService.userTyping(chatId, principal);
        return "DONE";
    }


}