@e-mail-sending-service @front-internal @blast-radius-high
Feature: E-Mail sending service — e-mail-sending-service
  A generic e-mail sending service that exposes a contract for others to send emails with a given content

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

    @AC-3 @complex
    Scenario Outline: While <n> retries have already been attempted for the e-mail, if an SMTP timeout occurs on the re-authentication attempt, the system shall schedule a retry with <delay_seconds> seconds backoff delay
      Given <n> retries have already been attempted for the e-mail
      When an SMTP timeout occurs on the re-authentication attempt
      Then the system shall schedule a retry with <delay_seconds> seconds backoff delay

      Examples:
        | delay_seconds | n |
        | 10 | 0 |
        | 30 | 1 |

  @RQ-2
  Rule: The service sends a well-formed email on request

    @AC-4 @event
    Scenario: When a send is requested for {input.recipient}, the system shall compose an email addressed to {input.recipient}
      When a send is requested for {input.recipient}
      Then the system shall compose an email addressed to {input.recipient}
      And the system shall set the email subject to {input.subject}
      And the system shall set the email body to {input.content}
      And the system shall attach {input.attachment} to the email
      And the system shall hand the email to the SMTP server for delivery
