import { CATEGORY_COLORS } from "./colors";

export type CategoryType = "expense" | "income" | "transfer";

export interface DefaultCategory {
  name: string;
  categoryType: CategoryType;
  color: string;
  icon: string;
  description?: string;
  categorizationInstructions?: string;
  isSystem?: boolean;
  hideFromSelection?: boolean;
}

export const DEFAULT_EXPENSE_CATEGORIES: DefaultCategory[] = [
  {
    name: "Food & Dining",
    categoryType: "expense",
    color: CATEGORY_COLORS[0].value, // Amber
    icon: "RiRestaurantLine",
    description: "Restaurants, food delivery, cafes",
  },
  {
    name: "Groceries",
    categoryType: "expense",
    color: CATEGORY_COLORS[8].value, // Emerald
    icon: "RiShoppingCartLine",
    description: "Supermarkets, grocery stores, household essentials",
  },
  {
    name: "Transportation",
    categoryType: "expense",
    color: CATEGORY_COLORS[1].value, // Blue
    icon: "RiCarLine",
    description: "Fuel, public transit, parking, ride-sharing",
  },
  {
    name: "Shopping",
    categoryType: "expense",
    color: CATEGORY_COLORS[6].value, // Pink
    icon: "RiShoppingBagLine",
    description: "Clothing, electronics, general purchases",
  },
  {
    name: "Entertainment",
    categoryType: "expense",
    color: CATEGORY_COLORS[4].value, // Purple
    icon: "RiGamepadLine",
    description: "Movies, games, concerts, streaming services",
  },
  {
    name: "Bills & Utilities",
    categoryType: "expense",
    color: CATEGORY_COLORS[9].value, // Slate
    icon: "RiFileTextLine",
    description: "Electricity, water, internet, phone",
  },
  {
    name: "Health & Fitness",
    categoryType: "expense",
    color: CATEGORY_COLORS[2].value, // Green
    icon: "RiHeartPulseLine",
    description: "Gym, medical expenses, pharmacy",
  },
  {
    name: "Housing",
    categoryType: "expense",
    color: CATEGORY_COLORS[10].value, // Stone
    icon: "RiHome4Line",
    description: "Rent, mortgage, home maintenance",
  },
  {
    name: "Education",
    categoryType: "expense",
    color: CATEGORY_COLORS[7].value, // Indigo
    icon: "RiBookOpenLine",
    description: "Courses, books, tuition, training",
  },
  {
    name: "Travel",
    categoryType: "expense",
    color: CATEGORY_COLORS[5].value, // Teal
    icon: "RiPlaneLine",
    description: "Hotels, flights, vacation expenses",
  },
  {
    name: "Personal Care",
    categoryType: "expense",
    color: CATEGORY_COLORS[8].value, // Emerald
    icon: "RiUser3Line",
    description: "Haircuts, spa, personal hygiene",
  },
  {
    name: "Gifts & Donations",
    categoryType: "expense",
    color: CATEGORY_COLORS[3].value, // Red
    icon: "RiGiftLine",
    description: "Presents, charity donations",
  },
  {
    name: "Other Expenses",
    categoryType: "expense",
    color: CATEGORY_COLORS[11].value, // Zinc
    icon: "RiMore2Line",
    description: "Miscellaneous expenses",
  },
];

export const DEFAULT_INCOME_CATEGORIES: DefaultCategory[] = [
  {
    name: "Salary",
    categoryType: "income",
    color: CATEGORY_COLORS[2].value, // Green
    icon: "RiBriefcaseLine",
    description: "Regular employment income",
  },
  {
    name: "Other Income",
    categoryType: "income",
    color: CATEGORY_COLORS[9].value, // Slate
    icon: "RiAddCircleLine",
    description: "Miscellaneous income",
  },
  {
    name: "Refunds",
    categoryType: "income",
    color: CATEGORY_COLORS[1].value, // Blue
    icon: "RiArrowGoBackLine",
    description: "Refunds, reimbursements, chargebacks",
  },
  {
    name: "Freelance",
    categoryType: "income",
    color: CATEGORY_COLORS[5].value, // Teal
    icon: "RiComputerLine",
    description: "Freelance and contract work",
  },
];

export const DEFAULT_TRANSFER_CATEGORIES: DefaultCategory[] = [
  {
    name: "Internal Transfer",
    categoryType: "transfer",
    color: CATEGORY_COLORS[9].value, // Slate
    icon: "RiExchangeLine",
    description: "Transfers between your own accounts to move money internally",
    isSystem: true,
  },
  {
    name: "External Transfer",
    categoryType: "transfer",
    color: CATEGORY_COLORS[10].value, // Stone
    icon: "RiArrowLeftRightLine",
    description: "Money moved to or from external accounts not tracked here",
    isSystem: true,
  },
  {
    name: "Balancing Transfer",
    categoryType: "transfer",
    color: CATEGORY_COLORS[11].value, // Zinc
    icon: "RiScalesLine",
    description: "Balance adjustments for account reconciliation",
    isSystem: true,
    hideFromSelection: true,
  },
];

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  ...DEFAULT_EXPENSE_CATEGORIES,
  ...DEFAULT_INCOME_CATEGORIES,
  ...DEFAULT_TRANSFER_CATEGORIES,
];

export const AUSTRALIAN_DEFAULT_EXPENSE_CATEGORIES: DefaultCategory[] = [
  {
    name: "Food & Dining",
    categoryType: "expense",
    color: CATEGORY_COLORS[0].value,
    icon: "RiRestaurantLine",
    description: "Restaurants, cafes, takeaway, and delivery",
  },
  {
    name: "Groceries",
    categoryType: "expense",
    color: CATEGORY_COLORS[8].value,
    icon: "RiShoppingCartLine",
    description: "Woolworths, Coles, ALDI, IGA, markets, and household essentials",
    categorizationInstructions: "Use for Australian supermarket and grocery merchants such as Woolworths, Coles, ALDI, IGA, Harris Farm, and local food markets.",
  },
  {
    name: "Transport",
    categoryType: "expense",
    color: CATEGORY_COLORS[1].value,
    icon: "RiCarLine",
    description: "Fuel, tolls, parking, Opal, Myki, Translink, rideshare, and public transport",
    categorizationInstructions: "Use for fuel stations, tolls, parking, rideshare, and public transport systems such as Opal, Myki, go card, Translink, and Metro.",
  },
  {
    name: "Shopping",
    categoryType: "expense",
    color: CATEGORY_COLORS[6].value,
    icon: "RiShoppingBagLine",
    description: "Kmart, Big W, Amazon AU, clothing, electronics, and general purchases",
  },
  {
    name: "Entertainment",
    categoryType: "expense",
    color: CATEGORY_COLORS[4].value,
    icon: "RiGamepadLine",
    description: "Streaming, cinemas, sport, concerts, and events",
  },
  {
    name: "Bills & Utilities",
    categoryType: "expense",
    color: CATEGORY_COLORS[9].value,
    icon: "RiFileTextLine",
    description: "Electricity, gas, water, NBN, mobile, council rates, and insurance bills",
    categorizationInstructions: "Use for Australian utilities, telcos, rates, and recurring household bills including AGL, Origin, EnergyAustralia, Telstra, Optus, Vodafone, NBN, and council rates.",
  },
  {
    name: "Health & Fitness",
    categoryType: "expense",
    color: CATEGORY_COLORS[2].value,
    icon: "RiHeartPulseLine",
    description: "Medicare gaps, private health, chemists, GP visits, gym, and sport",
    categorizationInstructions: "Use for Medicare gap payments, private health insurance, chemists, pharmacies, GP clinics, allied health, gyms, and sport memberships.",
  },
  {
    name: "Housing",
    categoryType: "expense",
    color: CATEGORY_COLORS[10].value,
    icon: "RiHome4Line",
    description: "Rent, mortgage repayments, strata, rates, repairs, and home maintenance",
    categorizationInstructions: "Use for rent, mortgage repayments, strata/body corporate, council rates, property management fees, repairs, and home maintenance.",
  },
  {
    name: "Education",
    categoryType: "expense",
    color: CATEGORY_COLORS[7].value,
    icon: "RiBookOpenLine",
    description: "Courses, books, school costs, training, and professional development",
  },
  {
    name: "Travel",
    categoryType: "expense",
    color: CATEGORY_COLORS[5].value,
    icon: "RiPlaneLine",
    description: "Flights, hotels, car hire, holidays, and weekend trips",
  },
  {
    name: "Personal Care",
    categoryType: "expense",
    color: CATEGORY_COLORS[8].value,
    icon: "RiUser3Line",
    description: "Haircuts, beauty, personal hygiene, and clothing care",
  },
  {
    name: "Gifts & Donations",
    categoryType: "expense",
    color: CATEGORY_COLORS[3].value,
    icon: "RiGiftLine",
    description: "Gifts, charities, school fundraisers, and community donations",
  },
  {
    name: "Other Expenses",
    categoryType: "expense",
    color: CATEGORY_COLORS[11].value,
    icon: "RiMore2Line",
    description: "Miscellaneous expenses",
  },
];

export const AUSTRALIAN_DEFAULT_INCOME_CATEGORIES: DefaultCategory[] = [
  {
    name: "Salary",
    categoryType: "income",
    color: CATEGORY_COLORS[2].value,
    icon: "RiBriefcaseLine",
    description: "Salary and wages after PAYG withholding",
  },
  {
    name: "Other Income",
    categoryType: "income",
    color: CATEGORY_COLORS[9].value,
    icon: "RiAddCircleLine",
    description: "Miscellaneous income",
  },
  {
    name: "Refunds",
    categoryType: "income",
    color: CATEGORY_COLORS[1].value,
    icon: "RiArrowGoBackLine",
    description: "Refunds, Medicare rebates, reimbursements, and chargebacks",
    categorizationInstructions: "Use for merchant refunds, Medicare rebates, insurance reimbursements, work reimbursements, and payment reversals.",
  },
  {
    name: "Freelance",
    categoryType: "income",
    color: CATEGORY_COLORS[5].value,
    icon: "RiComputerLine",
    description: "ABN, freelance, sole trader, and contract income",
    categorizationInstructions: "Use for ABN, sole trader, freelance, consulting, contractor, and side business income.",
  },
  {
    name: "Investment Income",
    categoryType: "income",
    color: CATEGORY_COLORS[4].value,
    icon: "RiLineChartLine",
    description: "Interest, dividends, distributions, and franking credits",
    categorizationInstructions: "Use for bank interest, dividends, ETF/managed fund distributions, franking credits, and investment income cash receipts.",
  },
];

export const AUSTRALIAN_DEFAULT_CATEGORIES: DefaultCategory[] = [
  ...AUSTRALIAN_DEFAULT_EXPENSE_CATEGORIES,
  ...AUSTRALIAN_DEFAULT_INCOME_CATEGORIES,
  ...DEFAULT_TRANSFER_CATEGORIES,
];

export function getDefaultCategoriesForCountry(countryCode: string | null | undefined): DefaultCategory[] {
  return countryCode === "AU" ? AUSTRALIAN_DEFAULT_CATEGORIES : DEFAULT_CATEGORIES;
}

export function getCategoriesByType(type: CategoryType): DefaultCategory[] {
  return DEFAULT_CATEGORIES.filter((category) => category.categoryType === type);
}
