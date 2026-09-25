@receipt-intake @front-external @blast-radius-medium
Feature: Receipt submission portal — receipt-portal
  The public entry point where a submitter hands in a receipt PDF for archiving and confirmation.

  @RQ-1
  Rule: A submitter who floods the portal is throttled before the intake sees the receipt

    @AC-1 @unwanted
    Scenario Outline: If {input.submitter_address} has submitted more than <max_submissions> receipts in the past hour, the system shall reject {input.file} without handing it to the intake
      When {input.submitter_address} has submitted more than <max_submissions> receipts in the past hour
      Then the system shall reject {input.file} without handing it to the intake

      Examples:
        | max_submissions |
        | 10 |
