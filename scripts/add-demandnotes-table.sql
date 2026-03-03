USE [LeaseManagementDB];
GO

IF OBJECT_ID('dbo.DemandNotes', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.DemandNotes (
    DemandNoteID INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    LesseeID INT NOT NULL,
    LeaseID INT NULL,
    GeneratedByUserID INT NOT NULL,
    GeneratedAt DATETIME2 NOT NULL CONSTRAINT DF_DemandNotes_GeneratedAt DEFAULT SYSUTCDATETIME(),
    DueDate DATE NULL,
    Amount DECIMAL(18,2) NULL,
    Description NVARCHAR(1000) NULL,
    DocumentPath NVARCHAR(500) NOT NULL,
    DocumentFileName NVARCHAR(260) NOT NULL,
    Status NVARCHAR(20) NOT NULL CONSTRAINT DF_DemandNotes_Status DEFAULT 'Generated',
    IssuedByUserID INT NULL,
    IssuedAt DATETIME2 NULL,
    RejectedByUserID INT NULL,
    RejectedAt DATETIME2 NULL,
    AdminRemarks NVARCHAR(500) NULL,
    CONSTRAINT FK_DemandNotes_Lessees FOREIGN KEY (LesseeID) REFERENCES dbo.Lessees(LesseeID),
    CONSTRAINT FK_DemandNotes_LeaseDetails FOREIGN KEY (LeaseID) REFERENCES dbo.LeaseDetails(LeaseID),
    CONSTRAINT FK_DemandNotes_GeneratedBy FOREIGN KEY (GeneratedByUserID) REFERENCES dbo.Users(UserID),
    CONSTRAINT FK_DemandNotes_IssuedBy FOREIGN KEY (IssuedByUserID) REFERENCES dbo.Users(UserID),
    CONSTRAINT FK_DemandNotes_RejectedBy FOREIGN KEY (RejectedByUserID) REFERENCES dbo.Users(UserID)
  );
END;
GO
