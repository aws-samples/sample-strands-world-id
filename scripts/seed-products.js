#!/usr/bin/env node

/**
 * Seed script to populate DynamoDB Products table with computer parts.
 * Run: node scripts/seed-products.js
 *
 * Prerequisites:
 * - AWS credentials configured
 * - DynamoDB table 'AnyCompanyAgentProducts' exists
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || 'us-west-2';
const TABLE_NAME = process.env.PRODUCTS_TABLE || 'AnyCompanyAgentProducts';

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

const products = [
  // CPUs
  {
    id: 'cpu-001',
    name: 'Intel Core i9-14900K',
    brand: 'Intel',
    category: 'CPU',
    price: 549,
    releaseDate: '2023-10-17',
    specs: {
      cores: 24,
      threads: 32,
      baseClock: '3.2 GHz',
      boostClock: '6.0 GHz',
      tdp: 125,
      socket: 'LGA1700',
    },
    description: 'Flagship 14th Gen Intel processor with 24 cores (8P+16E) and up to 6.0 GHz boost clock. Excellent for gaming and content creation.',
  },
  {
    id: 'cpu-002',
    name: 'AMD Ryzen 9 7950X3D',
    brand: 'AMD',
    category: 'CPU',
    price: 699,
    releaseDate: '2023-02-28',
    specs: {
      cores: 16,
      threads: 32,
      baseClock: '4.2 GHz',
      boostClock: '5.7 GHz',
      tdp: 120,
      socket: 'AM5',
    },
    description: "AMD's gaming flagship with 3D V-Cache technology. 144MB total cache delivers unmatched gaming performance.",
  },
  {
    id: 'cpu-003',
    name: 'Intel Core i5-14600K',
    brand: 'Intel',
    category: 'CPU',
    price: 319,
    releaseDate: '2023-10-17',
    specs: {
      cores: 14,
      threads: 20,
      baseClock: '3.5 GHz',
      boostClock: '5.3 GHz',
      tdp: 125,
      socket: 'LGA1700',
    },
    description: 'Mid-range powerhouse with 14 cores (6P+8E). Great value for gaming and productivity workloads.',
  },
  {
    id: 'cpu-004',
    name: 'AMD Ryzen 5 7600X',
    brand: 'AMD',
    category: 'CPU',
    price: 229,
    releaseDate: '2022-09-27',
    specs: {
      cores: 6,
      threads: 12,
      baseClock: '4.7 GHz',
      boostClock: '5.3 GHz',
      tdp: 105,
      socket: 'AM5',
    },
    description: 'Efficient 6-core processor for budget-conscious gamers. Excellent single-thread performance.',
  },

  // GPUs
  {
    id: 'gpu-001',
    name: 'NVIDIA GeForce RTX 4090',
    brand: 'NVIDIA',
    category: 'GPU',
    price: 1599,
    releaseDate: '2022-10-12',
    specs: {
      vram: '24GB GDDR6X',
      coreClock: '2.52 GHz',
      cudaCores: 16384,
      tdp: 450,
    },
    description: 'The ultimate graphics card for 4K gaming and AI workloads. Unmatched performance in every benchmark.',
  },
  {
    id: 'gpu-002',
    name: 'AMD Radeon RX 7900 XTX',
    brand: 'AMD',
    category: 'GPU',
    price: 949,
    releaseDate: '2022-12-13',
    specs: {
      vram: '24GB GDDR6',
      coreClock: '2.5 GHz',
      streamProcessors: 6144,
      tdp: 355,
    },
    description: "AMD's flagship GPU with 24GB VRAM. Excellent 4K performance at a competitive price.",
  },
  {
    id: 'gpu-003',
    name: 'NVIDIA GeForce RTX 4070 Ti Super',
    brand: 'NVIDIA',
    category: 'GPU',
    price: 799,
    releaseDate: '2024-01-24',
    specs: {
      vram: '16GB GDDR6X',
      coreClock: '2.61 GHz',
      cudaCores: 8448,
      tdp: 285,
    },
    description: 'Sweet spot for 1440p gaming with DLSS 3 support. Great ray tracing performance.',
  },
  {
    id: 'gpu-004',
    name: 'AMD Radeon RX 7800 XT',
    brand: 'AMD',
    category: 'GPU',
    price: 499,
    releaseDate: '2023-09-06',
    specs: {
      vram: '16GB GDDR6',
      coreClock: '2.43 GHz',
      streamProcessors: 3840,
      tdp: 263,
    },
    description: 'Best value for 1440p gaming. 16GB VRAM future-proofs your build.',
  },

  // RAM
  {
    id: 'ram-001',
    name: 'Corsair Vengeance DDR5-6000 32GB (2x16GB)',
    brand: 'Corsair',
    category: 'RAM',
    price: 124,
    releaseDate: '2023-03-15',
    specs: {
      capacity: '32GB (2x16GB)',
      speed: 'DDR5-6000',
      latency: 'CL36',
      voltage: '1.35V',
    },
    description: 'High-performance DDR5 kit optimized for Intel and AMD platforms. Low-profile heatspreader.',
  },
  {
    id: 'ram-002',
    name: 'G.Skill Trident Z5 RGB DDR5-6400 32GB (2x16GB)',
    brand: 'G.Skill',
    category: 'RAM',
    price: 154,
    releaseDate: '2023-06-20',
    specs: {
      capacity: '32GB (2x16GB)',
      speed: 'DDR5-6400',
      latency: 'CL32',
      voltage: '1.4V',
    },
    description: 'Premium RGB memory with aggressive timings. Excellent for overclocking enthusiasts.',
  },
  {
    id: 'ram-003',
    name: 'Kingston Fury Beast DDR5-5600 32GB (2x16GB)',
    brand: 'Kingston',
    category: 'RAM',
    price: 99,
    releaseDate: '2023-01-10',
    specs: {
      capacity: '32GB (2x16GB)',
      speed: 'DDR5-5600',
      latency: 'CL40',
      voltage: '1.25V',
    },
    description: 'Reliable DDR5 memory at an affordable price. Great for budget builds.',
  },

  // Storage
  {
    id: 'storage-001',
    name: 'Samsung 990 Pro 2TB NVMe',
    brand: 'Samsung',
    category: 'Storage',
    price: 179,
    releaseDate: '2022-11-01',
    specs: {
      capacity: '2TB',
      interface: 'PCIe 4.0 x4',
      readSpeed: '7450 MB/s',
      writeSpeed: '6900 MB/s',
    },
    description: "Samsung's flagship consumer SSD with exceptional performance and reliability.",
  },
  {
    id: 'storage-002',
    name: 'WD Black SN850X 2TB',
    brand: 'Western Digital',
    category: 'Storage',
    price: 149,
    releaseDate: '2022-08-03',
    specs: {
      capacity: '2TB',
      interface: 'PCIe 4.0 x4',
      readSpeed: '7300 MB/s',
      writeSpeed: '6600 MB/s',
    },
    description: 'Game-optimized NVMe SSD with predictive loading. Great value for gamers.',
  },
  {
    id: 'storage-003',
    name: 'Crucial T700 2TB',
    brand: 'Crucial',
    category: 'Storage',
    price: 249,
    releaseDate: '2023-05-15',
    specs: {
      capacity: '2TB',
      interface: 'PCIe 5.0 x4',
      readSpeed: '12400 MB/s',
      writeSpeed: '11800 MB/s',
    },
    description: 'Blazing fast PCIe 5.0 SSD. Future-proof storage for enthusiast builds.',
  },

  // Motherboards
  {
    id: 'mobo-001',
    name: 'ASUS ROG Maximus Z790 Hero',
    brand: 'ASUS',
    category: 'Motherboard',
    price: 629,
    releaseDate: '2022-10-20',
    specs: {
      socket: 'LGA1700',
      chipset: 'Z790',
      formFactor: 'ATX',
      memorySlots: 4,
      maxMemory: '192GB DDR5',
    },
    description: 'Premium Intel motherboard with robust VRMs and extensive connectivity. Built for overclocking.',
  },
  {
    id: 'mobo-002',
    name: 'MSI MEG Z790 ACE',
    brand: 'MSI',
    category: 'Motherboard',
    price: 599,
    releaseDate: '2022-10-20',
    specs: {
      socket: 'LGA1700',
      chipset: 'Z790',
      formFactor: 'ATX',
      memorySlots: 4,
      maxMemory: '192GB DDR5',
    },
    description: 'High-end Intel board with 24+1+2 phase VRM design. Excellent for high-core-count CPUs.',
  },
  {
    id: 'mobo-003',
    name: 'Gigabyte X670E Aorus Master',
    brand: 'Gigabyte',
    category: 'Motherboard',
    price: 479,
    releaseDate: '2022-09-27',
    specs: {
      socket: 'AM5',
      chipset: 'X670E',
      formFactor: 'ATX',
      memorySlots: 4,
      maxMemory: '128GB DDR5',
    },
    description: 'Feature-rich AMD motherboard with dual PCIe 5.0 slots. Great for Ryzen 7000 series.',
  },
  {
    id: 'mobo-004',
    name: 'ASRock B650M Pro RS',
    brand: 'ASRock',
    category: 'Motherboard',
    price: 159,
    releaseDate: '2022-10-10',
    specs: {
      socket: 'AM5',
      chipset: 'B650',
      formFactor: 'Micro-ATX',
      memorySlots: 4,
      maxMemory: '128GB DDR5',
    },
    description: 'Budget AMD motherboard with solid features. Perfect for mid-range Ryzen builds.',
  },

  // PSUs
  {
    id: 'psu-001',
    name: 'Corsair RM1000x (2021)',
    brand: 'Corsair',
    category: 'PSU',
    price: 189,
    releaseDate: '2021-09-14',
    specs: {
      wattage: 1000,
      efficiency: '80+ Gold',
      modular: 'Fully Modular',
      warranty: '10 years',
    },
    description: 'Reliable 1000W PSU with 80+ Gold efficiency. Zero RPM mode for silent operation.',
  },
  {
    id: 'psu-002',
    name: 'EVGA SuperNOVA 1000 G7',
    brand: 'EVGA',
    category: 'PSU',
    price: 179,
    releaseDate: '2022-03-01',
    specs: {
      wattage: 1000,
      efficiency: '80+ Gold',
      modular: 'Fully Modular',
      warranty: '10 years',
    },
    description: 'Compact 1000W PSU with excellent ripple suppression. Great cable management.',
  },
  {
    id: 'psu-003',
    name: 'Seasonic Prime TX-850',
    brand: 'Seasonic',
    category: 'PSU',
    price: 249,
    releaseDate: '2022-06-15',
    specs: {
      wattage: 850,
      efficiency: '80+ Titanium',
      modular: 'Fully Modular',
      warranty: '12 years',
    },
    description: 'Premium 80+ Titanium PSU with industry-leading efficiency and build quality.',
  },
  {
    id: 'psu-004',
    name: 'be quiet! Pure Power 12 M 750W',
    brand: 'be quiet!',
    category: 'PSU',
    price: 109,
    releaseDate: '2023-02-01',
    specs: {
      wattage: 750,
      efficiency: '80+ Gold',
      modular: 'Fully Modular',
      warranty: '5 years',
    },
    description: 'Quiet and efficient PSU for mid-range builds. ATX 3.0 ready with 12VHPWR connector.',
  },

  // Cases
  {
    id: 'case-001',
    name: 'Lian Li O11 Dynamic EVO',
    brand: 'Lian Li',
    category: 'Case',
    price: 179,
    releaseDate: '2022-01-15',
    specs: {
      formFactor: 'Mid-Tower',
      motherboardSupport: 'E-ATX, ATX, Micro-ATX',
      maxGpuLength: '420mm',
      maxCpuCoolerHeight: '167mm',
    },
    description: 'Iconic dual-chamber design with excellent airflow. Perfect for custom water cooling.',
  },
  {
    id: 'case-002',
    name: 'NZXT H7 Flow',
    brand: 'NZXT',
    category: 'Case',
    price: 129,
    releaseDate: '2022-08-23',
    specs: {
      formFactor: 'Mid-Tower',
      motherboardSupport: 'ATX, Micro-ATX, Mini-ITX',
      maxGpuLength: '400mm',
      maxCpuCoolerHeight: '185mm',
    },
    description: 'Clean aesthetic with perforated front panel for airflow. Easy cable management.',
  },
  {
    id: 'case-003',
    name: 'Fractal Design Torrent',
    brand: 'Fractal Design',
    category: 'Case',
    price: 229,
    releaseDate: '2021-10-14',
    specs: {
      formFactor: 'Mid-Tower',
      motherboardSupport: 'E-ATX, ATX, Micro-ATX',
      maxGpuLength: '461mm',
      maxCpuCoolerHeight: '188mm',
    },
    description: 'Airflow-focused design with massive 180mm front fans. Best-in-class cooling performance.',
  },
  {
    id: 'case-004',
    name: 'Corsair 4000D Airflow',
    brand: 'Corsair',
    category: 'Case',
    price: 104,
    releaseDate: '2020-08-18',
    specs: {
      formFactor: 'Mid-Tower',
      motherboardSupport: 'ATX, Micro-ATX, Mini-ITX',
      maxGpuLength: '360mm',
      maxCpuCoolerHeight: '170mm',
    },
    description: 'Excellent value with high airflow mesh front. Clean, minimalist design.',
  },

  // Coolers
  {
    id: 'cooler-001',
    name: 'Noctua NH-D15 chromax.black',
    brand: 'Noctua',
    category: 'Cooler',
    price: 109,
    releaseDate: '2019-10-01',
    specs: {
      type: 'Air Cooler',
      height: '165mm',
      fans: '2x 140mm',
      tdpRating: '250W',
    },
    description: 'Legendary air cooler performance in all-black. Rivals many 280mm AIOs.',
  },
  {
    id: 'cooler-002',
    name: 'NZXT Kraken X73 RGB',
    brand: 'NZXT',
    category: 'Cooler',
    price: 199,
    releaseDate: '2023-01-10',
    specs: {
      type: 'AIO Liquid Cooler',
      radiatorSize: '360mm',
      fans: '3x 120mm',
      tdpRating: '350W',
    },
    description: '360mm AIO with stunning RGB infinity mirror pump head. CAM software control.',
  },
  {
    id: 'cooler-003',
    name: 'Thermalright Peerless Assassin 120 SE',
    brand: 'Thermalright',
    category: 'Cooler',
    price: 35,
    releaseDate: '2022-05-15',
    specs: {
      type: 'Air Cooler',
      height: '155mm',
      fans: '2x 120mm',
      tdpRating: '220W',
    },
    description: 'Budget king with exceptional cooling. Best value air cooler on the market.',
  },
  {
    id: 'cooler-004',
    name: 'Arctic Liquid Freezer II 280',
    brand: 'Arctic',
    category: 'Cooler',
    price: 109,
    releaseDate: '2022-03-01',
    specs: {
      type: 'AIO Liquid Cooler',
      radiatorSize: '280mm',
      fans: '2x 140mm',
      tdpRating: '300W',
    },
    description: 'Excellent 280mm AIO with integrated VRM fan. Outstanding price-to-performance.',
  },
];

async function seedProducts() {
  console.log(`Seeding ${products.length} products to ${TABLE_NAME}...`);

  // DynamoDB BatchWrite can handle max 25 items at a time
  const batchSize = 25;

  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);

    const putRequests = batch.map((product) => ({
      PutRequest: {
        Item: product,
      },
    }));

    const command = new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: putRequests,
      },
    });

    try {
      await docClient.send(command);
      console.log(`  Seeded batch ${Math.floor(i / batchSize) + 1} (${batch.length} items)`);
    } catch (error) {
      console.error(`Error seeding batch:`, error);
      throw error;
    }
  }

  console.log('Done! Products seeded successfully.');
}

seedProducts().catch((error) => {
  console.error('Failed to seed products:', error);
  process.exit(1);
});
