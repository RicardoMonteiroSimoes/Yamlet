@pdf-upload @front-external @blast-radius-medium
Feature: PDF upload — pdf-upload
  Accepts an uploaded file, verifies it is a well-formed PDF, and returns the validated PDF.

  @RQ-1
  Rule: The service accepts a valid upload and returns the validated PDF

    @AC-1 @event
    Scenario: When {input.file} named {input.filename} is uploaded, the system shall verify {input.file} is a well-formed PDF within the size limit
      When {input.file} named {input.filename} is uploaded
      Then the system shall verify {input.file} is a well-formed PDF within the size limit
      And the system shall return {output.pdf_file} to the caller
      And the system shall preserve {input.filename} as the name of the returned PDF

  @RQ-2
  Rule: The service rejects untrusted or malformed uploads

    @AC-2 @unwanted
    Scenario: If {input.file} is not a well-formed PDF, the system shall reject the upload
      When {input.file} is not a well-formed PDF
      Then the system shall reject the upload
      And the system shall return {output.error} describing why {input.file} is not a well-formed PDF
      And the system shall return no {output.pdf_file}

    @AC-3 @unwanted
    Scenario: If {input.file} exceeds 10 MiB, the system shall reject the upload
      When {input.file} exceeds 10 MiB
      Then the system shall reject the upload
      And the system shall return {output.error} stating {input.file} exceeds the size limit
      And the system shall return no {output.pdf_file}
