@pdf-archiver @front-internal @blast-radius-medium
Feature: PDF e-mail archiver — pdf-archiver
  E-mails a validated PDF out to a configured archive address once it is uploaded.

  @RQ-1
  Rule: A validated PDF returned by the upload surface is reliably delivered to the configured archive address

    @AC-1 @event
    Scenario: When {uploads.pdf_file} is returned, the system shall ensure the archive e-mail is sent successfully
      When {uploads.pdf_file} is returned
      Then the system shall ensure the archive e-mail is sent successfully
