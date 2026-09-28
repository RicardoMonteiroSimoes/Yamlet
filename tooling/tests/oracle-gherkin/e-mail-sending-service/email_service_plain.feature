@e-mail-sending-service @front-internal @blast-radius-high
Feature: Attachment-free (plain) e-mail sending — e-mail-sending-service-plain
  A scope of the e-mail sending service that sends a plain e-mail — subject and content only, no attachment.

  @RQ-1
  Rule: A requested plain e-mail reaches its recipient with the given subject and content

    @AC-1 @event
    Scenario: When a send is requested for {input.recipient}, the system shall deliver an e-mail without attachment to {input.recipient}
      When a send is requested for {input.recipient}
      Then the system shall deliver an e-mail without attachment to {input.recipient}
      And the system shall use {input.subject} as the e-mail subject
      And the system shall use {input.content} as the e-mail body

  @RQ-2
  Rule: A requested plain e-mail is never silently lost

    @AC-2 @unwanted
    Scenario: If the e-mail to {input.recipient} cannot be delivered right away, the system shall deliver the e-mail to {input.recipient} within 24 hours of the request
      When the e-mail to {input.recipient} cannot be delivered right away
      Then the system shall deliver the e-mail to {input.recipient} within 24 hours of the request

    @AC-3 @unwanted
    Scenario: If the e-mail to {input.recipient} is still undelivered 24 hours after the request, the system shall mark the e-mail to {input.recipient} as undeliverable
      When the e-mail to {input.recipient} is still undelivered 24 hours after the request
      Then the system shall mark the e-mail to {input.recipient} as undeliverable
