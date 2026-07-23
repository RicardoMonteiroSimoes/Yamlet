@pdf-archiver @front-internal @blast-radius-medium
Feature: Resilient PDF e-mail archiver — pdf-archiver-resilient
  Archives an uploaded PDF by e-mail, and when the upload fails sends an attachment-free notification e-mail instead.

  @RQ-1
  Rule: A validated PDF is archived by e-mail, and a failed upload is notified by e-mail instead

    @AC-1 @event
    Scenario: When {uploads.pdf_file} is returned, the system shall ensure the archive e-mail carrying the PDF as an attachment is sent successfully
      When {uploads.pdf_file} is returned
      Then the system shall ensure the archive e-mail carrying the PDF as an attachment is sent successfully

    @AC-2 @unwanted
    Scenario: If the upload returns an {uploads.error} and no {uploads.pdf_file}, the system shall ensure a notification e-mail carrying {uploads.error} is sent to the alert address
      When the upload returns an {uploads.error} and no {uploads.pdf_file}
      Then the system shall ensure a notification e-mail carrying {uploads.error} is sent to the alert address
      And the system shall ensure the notification e-mail carries no attachment
