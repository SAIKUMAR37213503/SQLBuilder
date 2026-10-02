USE [master]
GO
/****** Object:  Database [AdventureWorksDW2025]    Script Date: 10/2/2026 8:30:00 AM ******/
CREATE DATABASE [AdventureWorksDW2025]
 CONTAINMENT = NONE
 ON  PRIMARY 
( NAME = N'AdventureWorksDW2025', FILENAME = N'C:\Data\AdventureWorksDW2025.mdf' , SIZE = 204800KB , MAXSIZE = UNLIMITED, FILEGROWTH = 16384KB )
GO
ALTER DATABASE [AdventureWorksDW2025] SET COMPATIBILITY_LEVEL = 170
GO
USE [AdventureWorksDW2025]
GO
/****** Object:  UserDefinedFunction [dbo].[udfBuildISO8601Date]    Script Date: 10/2/2026 8:30:00 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE FUNCTION [dbo].[udfBuildISO8601Date] (@year int, @month int, @day int)
RETURNS datetime
AS 
BEGIN
	RETURN cast(convert(varchar, @year) + '-' + [dbo].[udfTwoDigitZeroFill](@month) 
	    + '-' + [dbo].[udfTwoDigitZeroFill](@day) + 'T00:00:00' 
	    as datetime);
END;
GO
/****** Object:  Table [dbo].[DimCurrency]    Script Date: 10/2/2026 8:30:00 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[DimCurrency](
	[CurrencyKey] [int] IDENTITY(1,1) NOT NULL,
	[CurrencyAlternateKey] [nchar](3) NOT NULL,
	[CurrencyName] [nvarchar](50) NOT NULL,
 CONSTRAINT [PK_DimCurrency_CurrencyKey] PRIMARY KEY CLUSTERED 
(
	[CurrencyKey] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[DimCustomer]    Script Date: 10/2/2026 8:30:00 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[DimCustomer](
	[CustomerKey] [int] IDENTITY(1,1) NOT NULL,
	[FirstName] [nvarchar](50) COLLATE SQL_Latin1_General_CP1_CI_AS NULL,
	[LastName] [nvarchar](50) NULL,
	[BirthDate] [date] NULL,
	[YearlyIncome] [money] NULL,
	[Notes] [nvarchar](max) NULL,
	[Photo] [varbinary](max) NULL,
	[DateFirstPurchase] [datetime] NULL,
	[RowGuid] [uniqueidentifier] ROWGUIDCOL NOT NULL,
 CONSTRAINT [PK_DimCustomer_CustomerKey] PRIMARY KEY CLUSTERED 
(
	[CustomerKey] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Object:  Table [dbo].[FactInternetSales]    Script Date: 10/2/2026 8:30:00 AM ******/
CREATE TABLE [dbo].[FactInternetSales](
	[SalesOrderNumber] [nvarchar](20) NOT NULL,
	[SalesOrderLineNumber] [tinyint] NOT NULL,
	[CustomerKey] [int] NOT NULL,
	[CurrencyKey] [int] NOT NULL,
	[SalesAmount] [money] NOT NULL,
	[OrderDate] [datetime] NULL,
 CONSTRAINT [PK_FactInternetSales_SalesOrderNumber_SalesOrderLineNumber] PRIMARY KEY CLUSTERED 
(
	[SalesOrderNumber] ASC,
	[SalesOrderLineNumber] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  View [dbo].[vDMPrep]    Script Date: 10/2/2026 8:30:00 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE VIEW [dbo].[vDMPrep]
AS
    SELECT
        c.[CustomerKey]
        ,CASE WHEN Month(GetDate()) < Month(c.[BirthDate]) THEN 1 ELSE 0 END AS [Age]
    FROM [dbo].[DimCustomer] c;
GO
SET IDENTITY_INSERT [dbo].[DimCurrency] ON 

INSERT [dbo].[DimCurrency] ([CurrencyKey], [CurrencyAlternateKey], [CurrencyName]) VALUES (1, N'AFA', N'Afghani')
INSERT [dbo].[DimCurrency] ([CurrencyKey], [CurrencyAlternateKey], [CurrencyName]) VALUES (2, N'DZD', N'Algerian Dinar')
INSERT [dbo].[DimCurrency] ([CurrencyKey], [CurrencyAlternateKey], [CurrencyName]) VALUES (3, N'USD', N'US Dollar')
SET IDENTITY_INSERT [dbo].[DimCurrency] OFF
GO
SET IDENTITY_INSERT [dbo].[DimCustomer] ON 

INSERT [dbo].[DimCustomer] ([CustomerKey], [FirstName], [LastName], [BirthDate], [YearlyIncome], [Notes], [Photo], [DateFirstPurchase], [RowGuid]) VALUES (11000, N'Jon', N'Yang', CAST(N'1971-10-06' AS Date), 90000.0000, N'Line one
Line two with a GO
GO
and O''Brien''s ; semicolon', 0x47494638, CAST(N'2011-01-19T00:00:00.000' AS DateTime), N'0E0D6F5A-5E1B-4A3D-8C9F-2B1E5C7D8A9B')
INSERT [dbo].[DimCustomer] ([CustomerKey], [FirstName], [LastName], [BirthDate], [YearlyIncome], [Notes], [Photo], [DateFirstPurchase], [RowGuid]) VALUES (11001, N'Eugene', N'Huang', CAST(N'1976-05-10' AS Date), 60000.0000, NULL, NULL, CAST(N'2011-01-15T00:00:00.000' AS DateTime), N'1A2B3C4D-5E6F-4A3D-8C9F-2B1E5C7D8A9C')
SET IDENTITY_INSERT [dbo].[DimCustomer] OFF
GO
INSERT [dbo].[FactInternetSales] ([SalesOrderNumber], [SalesOrderLineNumber], [CustomerKey], [CurrencyKey], [SalesAmount], [OrderDate]) VALUES (N'SO43697', 1, 11000, 3, 3578.2700, CAST(N'2010-12-29T00:00:00.000' AS DateTime))
INSERT [dbo].[FactInternetSales] ([SalesOrderNumber], [SalesOrderLineNumber], [CustomerKey], [CurrencyKey], [SalesAmount], [OrderDate]) VALUES (N'SO43698', 1, 11001, 3, 3399.9900, CAST(N'2010-12-29T00:00:00.000' AS DateTime))
INSERT [dbo].[FactInternetSales] ([SalesOrderNumber], [SalesOrderLineNumber], [CustomerKey], [CurrencyKey], [SalesAmount], [OrderDate]) VALUES (N'SO43699', 1, 11000, 3, 699.0982, CAST(N'2010-12-30T00:00:00.000' AS DateTime))
GO
/****** Object:  Index [IX_DimCustomer_CustomerAlternateKey]    Script Date: 10/2/2026 8:30:00 AM ******/
CREATE UNIQUE NONCLUSTERED INDEX [IX_DimCustomer_LastName] ON [dbo].[DimCustomer]
(
	[LastName] ASC,
	[FirstName] ASC
)
INCLUDE([BirthDate]) WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, IGNORE_DUP_KEY = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
GO
ALTER TABLE [dbo].[DimCustomer] ADD  DEFAULT (newid()) FOR [RowGuid]
GO
ALTER TABLE [dbo].[FactInternetSales]  WITH CHECK ADD  CONSTRAINT [FK_FactInternetSales_DimCurrency] FOREIGN KEY([CurrencyKey])
REFERENCES [dbo].[DimCurrency] ([CurrencyKey])
GO
ALTER TABLE [dbo].[FactInternetSales] CHECK CONSTRAINT [FK_FactInternetSales_DimCurrency]
GO
ALTER TABLE [dbo].[DimCustomer]  WITH CHECK ADD  CONSTRAINT [CK_DimCustomer_Income] CHECK  (([YearlyIncome]>=(0)))
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Currency lookup' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'DimCurrency'
GO
USE [master]
GO
ALTER DATABASE [AdventureWorksDW2025] SET  READ_WRITE 
GO
