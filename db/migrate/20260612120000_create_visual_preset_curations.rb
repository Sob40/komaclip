class CreateVisualPresetCurations < ActiveRecord::Migration[8.1]
  def change
    create_table :visual_preset_curations do |t|
      t.string :preset_id, null: false
      t.boolean :general, null: false, default: false
      t.jsonb :genres, null: false, default: []
      t.text :notes

      t.timestamps
    end

    add_index :visual_preset_curations, :preset_id, unique: true
  end
end
