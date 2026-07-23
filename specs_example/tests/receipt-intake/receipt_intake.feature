@receipt-intake @front-internal @blast-radius-medium
Feature: Receipt intake with confirmation — receipt-intake
  Archives an uploaded receipt PDF by e-mail and sends the submitter a plain confirmation that it was received.

  @RQ-1
  Rule: A submitted receipt is, in one intake, both archived by e-mail and acknowledged to the submitter

    @AC-1 @event
    Scenario: When {input.file} named {input.filename} is submitted, the system shall hand {input.file} to the archiver to be e-mailed to {input.archive_address}
      When {input.file} named {input.filename} is submitted
      Then the system shall hand {input.file} to the archiver to be e-mailed to {input.archive_address}
      And the system shall send a plain confirmation e-mail to {input.submitter_address}
