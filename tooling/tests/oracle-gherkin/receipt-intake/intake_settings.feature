@receipt-intake @front-internal @blast-radius-medium
Feature: Receipt intake settings — intake-settings
  Supplies the deployment-configured archive and confirmation e-mail settings for receipt intake.

  @RQ-1
  Rule: The configured e-mail settings are supplied to the intake exactly as deployed

    @AC-1 @event
    Scenario: When the intake settings are read, the system shall return the deployed archive e-mail address as {output.archive_address}
      When the intake settings are read
      Then the system shall return the deployed archive e-mail address as {output.archive_address}
      And the system shall return the deployed archive subject and body as {output.archive_subject} and {output.archive_body}
      And the system shall return the deployed confirmation subject and body as {output.confirmation_subject} and {output.confirmation_body}

    @AC-2 @unwanted
    Scenario: If a setting has no deployed value, the system shall refuse to supply any setting
      When a setting has no deployed value
      Then the system shall refuse to supply any setting
