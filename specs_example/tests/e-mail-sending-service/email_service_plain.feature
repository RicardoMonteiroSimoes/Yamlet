@e-mail-sending-service @front-internal @blast-radius-high
Feature: Attachment-free (plain) e-mail sending — e-mail-sending-service-plain
  A scope of the e-mail sending service that sends a plain e-mail — subject and content only, no attachment.

  @RQ-1
  Rule: The service reliably connects to a single SMTP service

    @AC-1 @event
    Scenario: When a login is attempted using valid TLS SMTP credentials, the system shall authenticate to the SMTP server over TLS
      When a login is attempted using valid TLS SMTP credentials
      Then the system shall authenticate to the SMTP server over TLS

    @AC-2 @complex
    Scenario: While the service is authenticated at the SMTP server and an e-mail send is in progress, if an SMTP timeout occurs, the system shall re-authenticate to the SMTP server
      Given the service is authenticated at the SMTP server
      And an e-mail send is in progress
      When an SMTP timeout occurs
      Then the system shall re-authenticate to the SMTP server
      And the system shall resend the previously failed e-mail
      And the system shall ensure no e-mail is dropped in the process

  @RQ-2
  Rule: The service sends a well-formed attachment-free email on request

    @AC-3 @event
    Scenario: When a send is requested for {input.recipient}, the system shall compose an email addressed to {input.recipient}
      When a send is requested for {input.recipient}
      Then the system shall compose an email addressed to {input.recipient}
      And the system shall set the email subject to {input.subject}
      And the system shall set the email body to {input.content}
      And the system shall hand the email to the SMTP server for delivery
