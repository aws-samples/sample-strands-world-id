import { useState } from 'react';
import Header from './components/Header';
import ProductGrid from './components/ProductGrid';
import ChatPanel from './components/ChatPanel';
import { products, categories } from './data/products';

function App() {
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredProducts = products.filter((product) => {
    const matchesCategory = !selectedCategory || product.category === selectedCategory;
    const matchesSearch =
      !searchQuery ||
      product.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      product.brand.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="app">
      <Header
        categories={categories}
        selectedCategory={selectedCategory}
        onCategorySelect={setSelectedCategory}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />
      <main className="main-layout">
        <div className="products-panel">
          <div className="panel-header">
            <h2>
              {selectedCategory
                ? categories.find((c) => c.id === selectedCategory)?.name
                : 'All Products'}
            </h2>
            <span className="product-count">{filteredProducts.length} products</span>
          </div>
          <ProductGrid products={filteredProducts} />
        </div>
        <ChatPanel />
      </main>
    </div>
  );
}

export default App;
