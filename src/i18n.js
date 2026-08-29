const STRINGS = {
  en: {
    chooseCategory: 'Thank you! Please select the type of support you need below.',
    ticketCreatedDM:
      '✅ **Your ticket has been created.** Our staff will get back to you here as soon as possible. You can keep sending messages or attachments in this DM at any time — they will be forwarded automatically.',
    ticketClosedDM:
      '🔒 **Your ticket has been closed.** Thank you for contacting Signature. Feel free to send a new message here at any time to open another ticket.',
    waitingForButtons: 'Please use the buttons/menu above to continue — free text is not needed at this step.',
    ticketAlreadyOpen: 'You already have an open ticket — your message has been forwarded to our staff.',
    modalTitle: 'A few last details',
    newTicketChannelIntro: 'New modmail ticket',
  },
  fr: {
    chooseCategory: 'Merci ! Merci de sélectionner le type de support souhaité ci-dessous.',
    ticketCreatedDM:
      '✅ **Votre ticket a été créé.** Notre équipe vous répondra ici dès que possible. Vous pouvez continuer à envoyer des messages ou des pièces jointes dans ce message privé à tout moment — ils seront transmis automatiquement.',
    ticketClosedDM:
      '🔒 **Votre ticket a été fermé.** Merci d\'avoir contacté Signature. N\'hésitez pas à envoyer un nouveau message ici à tout moment pour ouvrir un autre ticket.',
    waitingForButtons: "Merci d'utiliser les boutons/menu ci-dessus pour continuer — inutile d'écrire un message à cette étape.",
    ticketAlreadyOpen: 'Vous avez déjà un ticket ouvert — votre message a été transmis à notre équipe.',
    modalTitle: 'Quelques derniers détails',
    newTicketChannelIntro: 'Nouveau ticket modmail',
  },
};

function t(lang, key) {
  const l = STRINGS[lang] ? lang : 'en';
  return STRINGS[l][key] || STRINGS.en[key] || key;
}

module.exports = { STRINGS, t };
